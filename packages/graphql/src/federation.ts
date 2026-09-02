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

import type { Database } from "@drfed/models";
import type { Actor, Instance } from "@drfed/models/schema";
import type { Context } from "@fedify/fedify";
import {
  Activity,
  Application,
  Endpoints,
  Group,
  Image,
  Organization,
  Person,
  Service,
  Tombstone,
} from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { validate as validateUuid } from "uuid";

import type { ServerContext } from "./builder.ts";

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

/**
 * An actor record joined with the instance it belongs to.
 */
type LocalActorRecord = Actor & { readonly instance: Instance };

async function findLocalActor(
  db: Database,
  ctx: Context<unknown>,
  identifier: string,
): Promise<LocalActorRecord | null> {
  if (!validateUuid(identifier)) return null;
  const actor = await db.query.actors.findFirst({
    where: { id: identifier },
    with: { instance: true },
  });
  return actor == null ||
    actor.localId == null ||
    actor.instance.host !== ctx.host
    ? null
    : actor;
}

async function findActiveActor(
  db: Database,
  ctx: Context<unknown>,
  identifier: string,
): Promise<LocalActorRecord | null> {
  const actor = await findLocalActor(db, ctx, identifier);
  return actor == null || actor.deleted != null ? null : actor;
}

/**
 * Registers the ActivityPub dispatchers on the `Federation` instance.
 * The registered paths define the URI layout of the federated objects,
 * which makes the object URI getters (e.g. `Context.getActorUri()`)
 * available.  Call this exactly once per `Federation` instance; Fedify
 * throws on duplicate registration.
 * @param context The server context holding the `Federation` instance.
 */
export default function buildFederation<
  T extends Pick<ServerContext, "db" | "federation">,
>({ db, federation }: T): void {
  federation
    .setActorDispatcher("/users/{identifier}", async (ctx, identifier) => {
      const actor = await findLocalActor(db, ctx, identifier);
      if (actor == null) return null;
      // Deleted actors are served as `Tombstone`s (HTTP 410) so that remote
      // peers purge them instead of retrying on 404.
      if (actor.deleted != null) {
        return new Tombstone({ id: ctx.getActorUri(identifier) });
      }
      return toActorObject(ctx, identifier, actor);
    })
    .mapHandle(async (ctx, username) => {
      const instance = await db.query.instances.findFirst({
        where: { host: ctx.host },
      });
      if (instance == null) return null;
      const actor = await db.query.actors.findFirst({
        where: { username, instanceId: instance.id },
      });
      return actor == null || actor.localId == null || actor.deleted != null
        ? null
        : actor.id;
    });
  // FIXME: Provide actor key pairs via setKeyPairsDispatcher() once the
  // data model stores signing keys.

  federation
    .setInboxListeners("/users/{identifier}/inbox", "/inbox")
    // FIXME: Record incoming activities once the data model can store them;
    // until then the catch-all below only surfaces them in the logs so that
    // deliveries are not silently discarded.
    .on(Activity, (_ctx, activity) => {
      logger.debug("Received an activity: {activity}", { activity });
    })
    .onError((_ctx, error) => {
      logger.error("An error occurred while processing an inbox: {error}", {
        error,
      });
    });

  federation.setOutboxDispatcher(
    "/users/{identifier}/outbox",
    async (ctx, identifier) =>
      // FIXME: Return the actual activities once the data model stores them
      (await findActiveActor(db, ctx, identifier)) == null
        ? null
        : { items: [] },
  );

  federation
    .setFollowersDispatcher(
      "/users/{identifier}/followers",
      async (ctx, identifier) =>
        // FIXME: Return the actual followers once the data model stores
        // follows
        (await findActiveActor(db, ctx, identifier)) == null
          ? null
          : { items: [] },
    )
    .setCounter(
      async (ctx, identifier) =>
        (await findActiveActor(db, ctx, identifier))?.followersCount ?? null,
    );

  federation
    .setFollowingDispatcher(
      "/users/{identifier}/followees",
      async (ctx, identifier) =>
        // FIXME: Return the actual followees once the data model stores
        // follows
        (await findActiveActor(db, ctx, identifier)) == null
          ? null
          : { items: [] },
    )
    .setCounter(
      async (ctx, identifier) =>
        (await findActiveActor(db, ctx, identifier))?.followeesCount ?? null,
    );

  federation.setFeaturedDispatcher(
    "/users/{identifier}/featured",
    async (ctx, identifier) =>
      // FIXME: Return the actual pinned objects once the data model stores
      // them
      (await findActiveActor(db, ctx, identifier)) == null
        ? null
        : { items: [] },
  );
}

// Whether a sanction is *currently* active is always determined by comparing
// against the current time (lazy expiry; no cron); see the actors table.
function isSuspended({ suspended, suspendedUntil }: Actor): boolean {
  const now = new Date();
  return (
    suspended != null &&
    suspended <= now &&
    (suspendedUntil == null || suspendedUntil > now)
  );
}

function toActorObject(
  ctx: Context<unknown>,
  identifier: string,
  actor: LocalActorRecord,
): ActorObject {
  return actorConstructors[actor.type]({
    id: ctx.getActorUri(identifier),
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
    inbox: ctx.getInboxUri(identifier),
    outbox: ctx.getOutboxUri(identifier),
    followers: ctx.getFollowersUri(identifier),
    following: ctx.getFollowingUri(identifier),
    featured: ctx.getFeaturedUri(identifier),
    endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
  });
}

const logger = getLogger(["drfed", "graphql", "federation"]);
