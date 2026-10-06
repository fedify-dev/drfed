// DrFed: A web-based platform for developing and debugging ActivityPub apps
// Copyright (C) 2026 DrFed team
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import type { Database, schema } from "@drfed/models";
import type { Actor, Resource } from "@drfed/models/schema";
import { type Uuid, validateUuid } from "@drfed/models/uuid";
import type { ActorKeyPair, Context, FederationBuilder } from "@fedify/fedify";
import {
  Application,
  Endpoints,
  Group,
  Image,
  Organization,
  Person,
  Service,
  Tombstone,
} from "@fedify/vocab";

import { ensureActorKeyPairs } from "./actor-key.ts";
import { canonicalizeAuthority } from "./origin.ts";

/**
 * The vocabulary object types that DrFed serves as actors.
 */
type ActorObject = Application | Group | Organization | Person | Service;

type ActorProps = ConstructorParameters<typeof Person>[0];

const actorConstructors: Record<
  Actor["type"],
  (props: ActorProps) => ActorObject
> = {
  Application: (props) => new Application(props),
  Group: (props) => new Group(props),
  Organization: (props) => new Organization(props),
  Person: (props) => new Person(props),
  Service: (props) => new Service(props),
};

type StoredActor = Actor & {
  resource: Resource;
  collectionReferences: (typeof schema.actorCollectionReferences.$inferSelect & {
    collection: typeof schema.collections.$inferSelect & { resource: Resource };
  })[];
};

async function findLocalActor(
  db: Database,
  ctx: Context<unknown>,
  identifier: string,
): Promise<StoredActor | null> {
  if (!validateUuid(identifier)) return null;
  const actor = await db.query.actors.findFirst({
    where: {
      id: identifier as Uuid,
      localId: { isNotNull: true },
      instance: { host: canonicalizeAuthority(ctx.host) },
    },
    with: {
      resource: true,
      collectionReferences: {
        with: { collection: { with: { resource: true } } },
      },
    },
  });
  return actor ?? null;
}

/**
 * Looks up a local actor of the instance the request arrived on, the way the
 * actor dispatcher does, but treats a deleted actor as missing.
 * @param db The database to resolve the actor from.
 * @param ctx The Fedify context of the request.
 * @param identifier The actor identifier from the request path.
 * @returns The actor, or `null` if it is not served.
 */
export async function findActiveActor(
  db: Database,
  ctx: Context<unknown>,
  identifier: string,
): Promise<StoredActor | null> {
  const actor = await findLocalActor(db, ctx, identifier);
  return actor == null || actor.deleted != null ? null : actor;
}

/**
 * Registers the actor dispatcher and its handle mapper.
 * @param builder The builder to register on.
 * @param db The database to resolve local actors from.
 */
export function registerActorDispatcher(
  builder: FederationBuilder<unknown>,
  db: Database,
): void {
  builder
    .setActorDispatcher("/users/{identifier}", async (ctx, identifier) => {
      const actor = await findLocalActor(db, ctx, identifier);
      if (actor == null) return null;
      // Deleted actors are served as `Tombstone`s (HTTP 410) so that remote
      // peers purge them instead of retrying on 404.
      if (actor.deleted != null) {
        return new Tombstone({ id: ctx.getActorUri(identifier) });
      }
      const keyContext = ctx.federation.createContext(
        new URL(actor.resource.iri),
        ctx.data,
      );
      const keys = await keyContext.getActorKeyPairs(actor.id);
      if (keys.length !== 2) {
        throw new Error("Could not load actor signing keys.");
      }
      return toActorObject(ctx, identifier, actor, keys);
    })
    .setKeyPairsDispatcher((ctx, identifier) =>
      ensureActorKeyPairs(db, ctx, identifier),
    )
    .mapHandle(async (ctx, username) => {
      const actor = await db.query.actors.findFirst({
        where: {
          username,
          localId: { isNotNull: true },
          instance: { host: canonicalizeAuthority(ctx.host) },
          deleted: { isNull: true },
        },
      });
      return actor?.id ?? null;
    });
}

// Whether a sanction is *currently* active is always determined by comparing
// against the current time (lazy expiry; no cron); see the actors table.
function isSuspended({ suspended, suspendedUntil }: Actor): boolean {
  const now = Temporal.Now.instant();
  return (
    suspended != null &&
    Temporal.Instant.compare(suspended, now) <= 0 &&
    (suspendedUntil == null ||
      Temporal.Instant.compare(suspendedUntil, now) > 0)
  );
}

function toActorObject(
  ctx: Context<unknown>,
  identifier: string,
  actor: StoredActor,
  keys: ActorKeyPair[],
): ActorObject {
  return actorConstructors[actor.type]({
    id: new URL(actor.resource.iri),
    publicKey: keys[0]!.cryptographicKey,
    assertionMethods: keys.map((key) => key.multikey),
    preferredUsername: actor.username,
    name: actor.name,
    summary: actor.bioHtml,
    url: actor.profileUrl == null ? null : new URL(actor.profileUrl),
    icon:
      actor.avatarUrl == null
        ? null
        : new Image({ url: new URL(actor.avatarUrl) }),
    image:
      actor.headerUrl == null
        ? null
        : new Image({ url: new URL(actor.headerUrl) }),
    manuallyApprovesFollowers: !actor.automaticallyApprovesFollowers,
    sensitive: actor.sensitive,
    suspended: isSuspended(actor),
    aliases: actor.aliases.map((alias) => new URL(alias)),
    inbox: new URL(actor.inboxUrl),
    outbox: collectionIri(actor, "outbox"),
    followers: collectionIri(actor, "followers"),
    following: collectionIri(actor, "following"),
    featured: collectionIri(actor, "featured"),
    endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
  });
}

function collectionIri(actor: StoredActor, role: string): URL | null {
  const reference = actor.collectionReferences.find(
    (entry) => entry.role === role,
  );
  return reference == null ? null : new URL(reference.collection.resource.iri);
}
