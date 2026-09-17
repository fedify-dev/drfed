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

import { type Database, schema } from "@drfed/models";
import { PUBLIC_RESOURCE_ID } from "@drfed/models/resource";
import type {
  ActivityPubObject,
  Actor,
  Addressing,
  ObjectType,
  Resource,
  StoredActivity,
} from "@drfed/models/schema";
import { type Uuid, validateUuid } from "@drfed/models/uuid";
import {
  type Context,
  type Federation,
  type FederationBuilder,
  type FederationOptions,
  createFederationBuilder,
} from "@fedify/fedify";
import {
  Object as APObject,
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
  Person,
  Service,
  Tombstone,
} from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { type SQL, type SQLWrapper, and, eq, sql } from "drizzle-orm";

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

async function findActiveActor(
  db: Database,
  ctx: Context<unknown>,
  identifier: string,
): Promise<StoredActor | null> {
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
          instance: { host: canonicalizeAuthority(ctx.host) },
          deleted: { isNull: true },
        },
      });
      return actor?.id ?? null;
    });
  // FIXME: https://github.com/fedify-dev/drfed/issues/87

  builder
    .setInboxListeners("/users/{identifier}/inbox", "/inbox")
    // FIXME: https://github.com/fedify-dev/drfed/issues/88
    .on(Activity, (_ctx, activity) => {
      logger.debug("Received an activity: {activity}", { activity });
    })
    .onError((_ctx, error) => {
      logger.error("An error occurred while processing an inbox: {error}", {
        error,
      });
    });

  builder.setObjectDispatcher<APObject, "identifier" | "id">(
    APObject,
    // Keep migration backfill IRI formats in sync when changing these paths.
    "/users/{identifier}/{id}",
    async (ctx, { identifier, id }) => {
      if (!validateUuid(identifier) || !validateUuid(id)) return null;
      const object = await db.query.objects.findFirst({
        where: {
          id,
          actorId: identifier,
          RAW: (table) => publicAddressing(table.id),
          actor: {
            localId: { isNotNull: true },
            deleted: { isNull: true },
            instance: { host: ctx.host },
          },
        },
        with: objectSelection,
      });
      if (object == null) return null;
      if (object.deleted != null) {
        return new Tombstone({
          id: ctx.getObjectUri(APObject, { identifier, id }),
          deleted: object.deleted,
        });
      }
      return toObject(ctx, object);
    },
  );

  builder.setObjectDispatcher<Create, "id">(
    Create,
    "/ap/creates/{id}",
    async (ctx, { id }) => {
      if (!validateUuid(id)) return null;
      const activity = await db.query.activities.findFirst({
        where: {
          resource: { iri: ctx.getObjectUri(Create, { id }).href },
          actor: {
            localId: { isNotNull: true },
            deleted: { isNull: true },
            instance: { host: ctx.host },
          },
          RAW: (table) => servedActivity(table),
        },
        with: activitySelection,
      });
      return activity == null ? null : toCreate(ctx, activity);
    },
  );

  builder
    .setOutboxDispatcher(
      "/users/{identifier}/outbox",
      async (ctx, identifier, cursor) => {
        if ((await findActiveActor(db, ctx, identifier)) == null) return null;
        const boundary = parseOutboxCursor(cursor);
        if (boundary === false) return null;
        const rows = await db.query.activities.findMany({
          where: {
            actorId: identifier as Uuid,
            RAW: (table) =>
              and(
                servedActivity(table),
                boundary == null
                  ? undefined
                  : sql`(${table.published}, ${table.id}) <
                      (${boundary.published}::timestamptz, ${boundary.id}::uuid)`,
              )!,
          },
          // Backfilled activity IDs are UUIDv4, so only publication time
          // determines chronology. Keep full database precision in cursors.
          extras: {
            cursorPublished: (table) =>
              sql<string>`to_char(${table.published} AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          },
          orderBy: { published: "desc", id: "desc" },
          limit: OUTBOX_PAGE_SIZE + 1,
          with: activitySelection,
        });
        const page = rows.slice(0, OUTBOX_PAGE_SIZE);
        return {
          items: page.map((object) => toCreate(ctx, object)),
          nextCursor:
            rows.length > OUTBOX_PAGE_SIZE
              ? `${page.at(-1)!.cursorPublished}|${page.at(-1)!.id}`
              : null,
        };
      },
    )
    .setFirstCursor(async (ctx, identifier) =>
      (await findActiveActor(db, ctx, identifier)) == null ? null : "",
    )
    .setCounter(async (ctx, identifier) => {
      const actor = await findActiveActor(db, ctx, identifier);
      return actor == null
        ? null
        : db.$count(
            schema.activities,
            and(
              eq(schema.activities.actorId, actor.id),
              servedActivity(schema.activities),
            ),
          );
    });

  builder
    .setFollowersDispatcher(
      "/users/{identifier}/followers",
      async (ctx, identifier) => {
        const collection = await actorCollection(
          db,
          ctx,
          identifier,
          "followers",
        );
        if (collection == null) return null;
        // FollowersDispatcher requires actor inboxes for future delivery fan-out.
        return {
          items: collection.items.map(({ item }) => ({
            id: new URL(item.iri),
            inboxId: item.actor == null ? null : new URL(item.actor.inboxUrl),
          })),
        };
      },
    )
    .setCounter(
      async (ctx, identifier) =>
        (await actorCollection(db, ctx, identifier, "followers"))?.items
          .length ?? null,
    );
  builder
    .setFollowingDispatcher(
      "/users/{identifier}/following",
      async (ctx, identifier) => {
        const collection = await actorCollection(
          db,
          ctx,
          identifier,
          "following",
        );
        return collection == null
          ? null
          : { items: collection.items.map(({ item }) => new URL(item.iri)) };
      },
    )
    .setCounter(
      async (ctx, identifier) =>
        (await actorCollection(db, ctx, identifier, "following"))?.items
          .length ?? null,
    );
  builder.setFeaturedDispatcher(
    "/users/{identifier}/featured",
    async (ctx, identifier) => {
      const collection = await actorCollection(db, ctx, identifier, "featured");
      return collection == null
        ? null
        : {
            items: collection.items.map(
              ({ item }) => new APObject({ id: new URL(item.iri) }),
            ),
          };
    },
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
): ActorObject {
  return actorConstructors[actor.type]({
    id: new URL(actor.resource.iri),
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

const logger = getLogger(["drfed", "graphql", "federation"]);

/**
 * Parse an opaque boundary without rounding database microseconds.
 * @returns The boundary, null for the first page, or false for invalid input.
 */
function parseOutboxCursor(
  cursor: string | null,
): { published: string; id: string } | null | false {
  if (cursor == null || cursor === "") return null;
  const [published, id, extra] = cursor.split("|");
  if (
    published == null ||
    published.startsWith("0000-") ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(published) ||
    id == null ||
    !validateUuid(id) ||
    extra != null
  ) {
    return false;
  }
  try {
    Temporal.Instant.from(published);
    return { published, id };
  } catch {
    return false;
  }
}

const OUTBOX_PAGE_SIZE = 20;
type ObjectProps = ConstructorParameters<typeof Note>[0];
const objectConstructors: Record<ObjectType, (props: ObjectProps) => APObject> =
  {
    Article: (props) => new Article(props),
    Note: (props) => new Note(props),
  };

type StoredAddressing = Addressing & { targetResource: Resource };
type StoredActor = Actor & {
  resource: Resource;
  collectionReferences: (typeof schema.actorCollectionReferences.$inferSelect & {
    collection: typeof schema.collections.$inferSelect & { resource: Resource };
  })[];
};
export const objectSelection = {
  resource: true,
  actor: { with: { resource: true } },
  addressing: { with: { targetResource: true }, orderBy: { position: "asc" } },
} as const;
export const activitySelection = {
  resource: true,
  actor: { with: { resource: true } },
  object: true,
  addressing: { with: { targetResource: true }, orderBy: { position: "asc" } },
} as const;
type StoredObject = ActivityPubObject & {
  resource: Resource;
  actor: Actor & { resource: Resource };
  addressing: StoredAddressing[];
};
type StoredCreate = StoredActivity & {
  resource: Resource;
  actor: Actor & { resource: Resource };
  object: Resource | null;
  addressing: StoredAddressing[];
};

function recipients(rows: readonly StoredAddressing[]): {
  tos: URL[];
  ccs: URL[];
  audiences: URL[];
} {
  const values = (property: string): URL[] =>
    rows
      .filter((entry) => entry.property === property)
      .toSorted((left, right) => left.position - right.position)
      .map((entry) => new URL(entry.targetResource.iri));
  return {
    tos: values("to"),
    ccs: values("cc"),
    audiences: values("audience"),
  };
}

/**
 * Shared Public predicate for object, activity, outbox page and counter.
 * @returns An EXISTS predicate matching explicit Public addressing.
 */
function publicAddressing(sourceId: SQLWrapper): SQL {
  return sql`exists (select 1 from ${schema.addressing} where ${schema.addressing.sourceId} = ${sourceId} and ${schema.addressing.targetId} = ${PUBLIC_RESOURCE_ID} and ${schema.addressing.property} in ('to', 'cc'))`;
}
function servedActivity(table: {
  id: SQLWrapper;
  objectId: SQLWrapper;
  type: SQLWrapper;
}): SQL {
  return sql`${table.type} = 'Create' and ${publicAddressing(table.id)} and exists (select 1 from ${schema.objects} where ${schema.objects.id} = ${table.objectId} and ${schema.objects.deleted} is null)`;
}
function collectionIri(actor: StoredActor, role: string): URL | null {
  const reference = actor.collectionReferences.find(
    (entry) => entry.role === role,
  );
  return reference == null ? null : new URL(reference.collection.resource.iri);
}
async function actorCollection(
  db: Database,
  ctx: Context<unknown>,
  identifier: string,
  role: "followers" | "following" | "featured",
) {
  const actor = await findActiveActor(db, ctx, identifier);
  if (actor == null) return null;
  const reference = await db.query.actorCollectionReferences.findFirst({
    where: { actorId: actor.id, role },
    with: {
      collection: {
        with: {
          items: {
            orderBy: { position: "asc", itemId: "asc" },
            with: { item: { with: { actor: true } } },
          },
        },
      },
    },
  });
  return reference?.collection ?? { items: [] };
}

/**
 * Serializes stored object addressing; blind recipients stay in the database.
 * @returns The vocabulary object without blind recipients.
 */
export function toObject(
  _ctx: Context<unknown>,
  object: StoredObject,
): APObject {
  return objectConstructors[object.type]({
    id: new URL(object.resource.iri),
    attribution: new URL(object.actor.resource.iri),
    contents: [
      object.contentHtml,
      ...(object.language == null
        ? []
        : [new LanguageString(object.contentHtml, object.language)]),
    ],
    name: object.name,
    summary: object.summary,
    sensitive: object.sensitive,
    published: object.published,
    updated: object.updated,
    url: object.url == null ? null : new URL(object.url),
    ...recipients(object.addressing),
  });
}

/**
 * Serializes a persisted Create activity, retaining its own IRI and addressing.
 * @returns The vocabulary activity without blind recipients.
 */
export function toCreate(
  _ctx: Context<unknown>,
  activity: StoredCreate,
): Create {
  return new Create({
    id: new URL(activity.resource.iri),
    actor: new URL(activity.actor.resource.iri),
    ...recipients(activity.addressing),
    object: activity.object == null ? null : new URL(activity.object.iri),
    published: activity.published,
  });
}
