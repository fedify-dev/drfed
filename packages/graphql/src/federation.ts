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
import type {
  ActivityPubObject,
  Actor,
  ObjectType,
} from "@drfed/models/schema";
import type { Uuid } from "@drfed/models/uuid";
import {
  type Context,
  type Federation,
  type FederationBuilder,
  type FederationOptions,
  createFederationBuilder,
} from "@fedify/fedify";
import {
  Object as ASObject,
  Activity,
  Application,
  Article,
  Create,
  Endpoints,
  Group,
  Image,
  LanguageString,
  Note,
  Organization,
  PUBLIC_COLLECTION,
  Person,
  Service,
  Tombstone,
} from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { validate as validateUuid } from "uuid";

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

async function findLocalActor(
  db: Database,
  ctx: Context<unknown>,
  identifier: string,
): Promise<Actor | null> {
  if (!validateUuid(identifier)) return null;
  const actor = await db.query.actors.findFirst({
    where: {
      id: identifier as Uuid,
      localId: { isNotNull: true },
      instance: { host: ctx.host },
    },
  });
  return actor ?? null;
}

async function findActiveActor(
  db: Database,
  ctx: Context<unknown>,
  identifier: string,
): Promise<Actor | null> {
  const actor = await findLocalActor(db, ctx, identifier);
  return actor == null || actor.deleted != null ? null : actor;
}

/**
 * Creates a `FederationBuilder` with every ActivityPub dispatcher and
 * listener that DrFed serves registered on it.  The registered paths define
 * the URI layout of the federated objects, which makes the object URI getters
 * (e.g. `Context.getActorUri()`) available once the builder is built.
 * @param db The database to resolve local actors from.
 * @returns A builder that has not been built yet.
 */
export function buildFederation(db: Database): FederationBuilder<unknown> {
  const builder = createFederationBuilder<unknown>();
  builder
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
      const actor = await db.query.actors.findFirst({
        where: {
          username,
          localId: { isNotNull: true },
          instance: { host: ctx.host },
          deleted: { isNull: true },
        },
      });
      return actor?.id ?? null;
    });
  // FIXME: Provide actor key pairs via setKeyPairsDispatcher() once the
  // data model stores signing keys.

  builder
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

  builder.setObjectDispatcher<ASObject, "identifier" | "id">(
    ASObject,
    "/users/{identifier}/objects/{id}",
    async (ctx, { identifier, id }) => {
      if (!validateUuid(identifier) || !validateUuid(id)) return null;
      const object = await db.query.objects.findFirst({
        where: {
          id,
          actorId: identifier,
          actor: {
            localId: { isNotNull: true },
            deleted: { isNull: true },
            instance: { host: ctx.host },
          },
        },
      });
      if (object == null || object.visibility === "followers") return null;
      if (object.deleted != null) {
        return new Tombstone({
          id: ctx.getObjectUri(ASObject, { identifier, id }),
          deleted: Temporal.Instant.from(object.deleted.toISOString()),
        });
      }
      return toObject(ctx, object);
    },
  );
  builder
    .setOutboxDispatcher(
      "/users/{identifier}/outbox",
      async (ctx, identifier, cursor) => {
        if ((await findActiveActor(db, ctx, identifier)) == null) return null;
        if (cursor != null && cursor !== "" && !validateUuid(cursor)) {
          return null;
        }
        const rows = await db.query.objects.findMany({
          where: {
            actorId: identifier,
            deleted: { isNull: true },
            visibility: { in: ["public", "unlisted"] },
            ...(cursor == null || cursor === "" ? {} : { id: { lt: cursor } }),
          },
          orderBy: { id: "desc" },
          limit: OUTBOX_PAGE_SIZE + 1,
        });
        const page = rows.slice(0, OUTBOX_PAGE_SIZE);
        return {
          items: page.map((object) => toCreate(ctx, object)),
          nextCursor: rows.length > OUTBOX_PAGE_SIZE ? page.at(-1)!.id : null,
        };
      },
    )
    .setFirstCursor(async (ctx, identifier) =>
      (await findActiveActor(db, ctx, identifier)) == null ? null : "",
    )
    .setCounter(
      async (ctx, identifier) =>
        (await findActiveActor(db, ctx, identifier))?.postsCount ?? null,
    );

  builder
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

  builder
    .setFollowingDispatcher(
      "/users/{identifier}/following",
      async (ctx, identifier) =>
        // FIXME: Return the actual following once the data model stores
        // follows
        (await findActiveActor(db, ctx, identifier)) == null
          ? null
          : { items: [] },
    )
    .setCounter(
      async (ctx, identifier) =>
        (await findActiveActor(db, ctx, identifier))?.followingCount ?? null,
    );

  builder.setFeaturedDispatcher(
    "/users/{identifier}/featured",
    async (ctx, identifier) =>
      // FIXME: Return the actual pinned objects once the data model stores
      // them
      (await findActiveActor(db, ctx, identifier)) == null
        ? null
        : { items: [] },
  );
  return builder;
}

/**
 * Creates a `Federation` instance with every DrFed dispatcher registered.
 * Every registration happens on a fresh builder inside this function, so the
 * returned instance is complete and must not be mutated further.
 * @param db The database to resolve local actors from.
 * @param options Options for the underlying Fedify `Federation`, such as
 *                the `kv` store.
 * @returns The built `Federation` instance.
 */
export default async function createFederation(
  db: Database,
  options: FederationOptions<unknown>,
): Promise<Federation<unknown>> {
  return await buildFederation(db).build(options);
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
  actor: Actor,
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

const OUTBOX_PAGE_SIZE = 20;
type ObjectProps = ConstructorParameters<typeof Note>[0];
const objectConstructors: Record<ObjectType, (props: ObjectProps) => ASObject> =
  {
    Article: (props) => new Article(props),
    Note: (props) => new Note(props),
  };

function recipients(
  ctx: Context<unknown>,
  object: ActivityPubObject,
): { tos: URL[]; ccs: URL[] } {
  const followers = ctx.getFollowersUri(object.actorId);
  switch (object.visibility) {
    case "public":
      return { tos: [PUBLIC_COLLECTION], ccs: [followers] };
    case "unlisted":
      return { tos: [followers], ccs: [PUBLIC_COLLECTION] };
    case "followers":
      return { tos: [followers], ccs: [] };
    default:
      throw new Error(
        `Unsupported visibility: ${object.visibility satisfies never}`,
      );
  }
}

function toObject(ctx: Context<unknown>, object: ActivityPubObject): ASObject {
  return objectConstructors[object.type]({
    id: new URL(object.iri),
    attribution: ctx.getActorUri(object.actorId),
    contents: [
      object.contentHtml,
      ...(object.language == null
        ? []
        : [new LanguageString(object.contentHtml, object.language)]),
    ],
    name: object.name,
    summary: object.summary,
    sensitive: object.sensitive,
    published: Temporal.Instant.from(object.published.toISOString()),
    updated: Temporal.Instant.from(object.updated.toISOString()),
    url: object.url == null ? null : new URL(object.url),
    ...recipients(ctx, object),
  });
}

function toCreate(ctx: Context<unknown>, object: ActivityPubObject): Create {
  return new Create({
    id: new URL(`${object.iri}/activity`),
    actor: ctx.getActorUri(object.actorId),
    object: toObject(ctx, object),
    published: Temporal.Instant.from(object.published.toISOString()),
    ...recipients(ctx, object),
  });
}
