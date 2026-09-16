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

// Keep dependent database writes and observations sequential.
// oxlint-disable no-await-in-loop

import {
  type Database,
  addActorCollectionItem,
  promoteResource,
  schema,
  storeAddressing,
} from "@drfed/models";
import { type AddressingInput, PUBLIC_IRI } from "@drfed/models/resource";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";
import type { PgInsertValue } from "drizzle-orm/pg-core";

import { hashSecret } from "./auth/hash.ts";

export const accepted = Temporal.Instant.from("2026-08-04T00:00:00.000Z");
export const created = Temporal.Instant.from("2026-08-04T00:00:00.000Z");
export const expires = Temporal.Instant.from("2030-08-04T00:00:00.000Z");
export const ok = 200;

export const accountId = "00000000-0000-4000-8000-000000000001";
export const localInstanceId = "00000000-0000-4000-8000-000000000101";
export const remoteInstanceId = "00000000-0000-4000-8000-000000000102";
export const localActorId = "00000000-0000-4000-8000-000000000201" as const;
export const remoteActorId = "00000000-0000-4000-8000-000000000202" as const;
export const sessionId = "00000000-0000-4000-8000-000000000301";
export const accessToken = "test-access-token";

export function globalId(
  type:
    | "Actor"
    | "LocalActor"
    | "Instance"
    | "Object"
    | "Activity"
    | "Collection",
  id: string,
): string {
  return Buffer.from(`${type}:${id}`).toString("base64");
}

export async function seedAuthenticatedLocalInstance(
  db: Database,
): Promise<RequestInit> {
  await db.insert(schema.accounts).values({
    id: accountId,
    email: "owner@example.com",
    name: "Owner",
    created,
  });
  await db.insert(schema.sessions).values({
    id: sessionId,
    accountId,
    tokenHash: await hashSecret(accessToken),
  });
  await seedLocalInstance(db);
  await db.insert(schema.instanceMembers).values({
    accountId,
    instanceId: localInstanceId,
    admin: true,
    accepted,
    created,
  });
  return { headers: { authorization: `Bearer ${accessToken}` } };
}

export async function seedLocalActor(db: Database): Promise<void> {
  await seedLocalInstance(db);
  await db.insert(schema.localActors).values({
    id: localActorId,
    avatar: "avatar.png",
    header: "header.png",
  });
  await seedActors(db, {
    id: localActorId,
    localId: localActorId,
    instanceId: localInstanceId,
    type: "Person",
    username: "alice",
    iri: `https://test-instance.drfed.org/users/${localActorId}`,
    inboxUrl: `https://test-instance.drfed.org/users/${localActorId}/inbox`,
    avatarUrl: `https://test-instance.drfed.org/users/${localActorId}/avatar/avatar.png`,
    headerUrl: `https://test-instance.drfed.org/users/${localActorId}/header/header.png`,
    profileUrl: "https://test-instance.drfed.org/@alice",
    created,
  });
}

export async function seedLocalInstance(db: Database): Promise<void> {
  await db
    .insert(schema.localInstances)
    .values({
      id: localInstanceId,
      slug: "test-instance",
      expires,
    })
    .onConflictDoNothing();
  await db
    .insert(schema.instances)
    .values({
      id: localInstanceId,
      localId: localInstanceId,
      created,
      host: "test-instance.drfed.org",
    })
    .onConflictDoNothing();
}

export async function seedRemoteActor(db: Database): Promise<void> {
  await db.insert(schema.instances).values({
    id: remoteInstanceId,
    created,
    host: "remote.example.com",
  });
  await seedActors(db, {
    id: remoteActorId,
    instanceId: remoteInstanceId,
    type: "Service",
    username: "bob",
    iri: "https://remote.example.com/users/bob",
    inboxUrl: "https://remote.example.com/users/bob/inbox",
    avatarUrl: "https://remote.example.com/users/bob/avatar.png",
    headerUrl: "https://remote.example.com/users/bob/header.png",
    profileUrl: "https://remote.example.com/@bob",
    created,
  });
}

type ActorSeed = PgInsertValue<typeof schema.actors> & {
  id: Uuid;
  iri: string;
};
export async function seedActors(
  db: Database,
  values: ActorSeed | ActorSeed[],
): Promise<void> {
  for (const { iri, ...actor } of Array.isArray(values) ? values : [values]) {
    await promoteResource(
      db,
      iri,
      "actor",
      async (tx, resource) => {
        await tx.insert(schema.actors).values({ ...actor, id: resource.id });
        for (const role of [
          "followers",
          "following",
          "featured",
          "outbox",
        ] as const) {
          await promoteResource(
            tx,
            `${iri}/${role}`,
            "collection",
            async (inner, collection) => {
              await inner.insert(schema.collections).values({
                id: collection.id,
                type: "OrderedCollection",
                ownerActorId: resource.id,
                role,
              });
              await inner.insert(schema.actorCollectionReferences).values({
                actorId: resource.id,
                role,
                collectionId: collection.id,
              });
            },
          );
        }
      },
      actor.id,
    );
  }
}
type ObjectSeed = PgInsertValue<typeof schema.objects> & {
  id: Uuid;
  iri: string;
  addressing?: AddressingInput;
  activityId?: Uuid;
};
/** Seeds independent Create rows using the legacy IRI layout for migration coverage. */
export async function seedObjects(
  db: Database,
  values: ObjectSeed | ObjectSeed[],
): Promise<void> {
  for (const {
    iri,
    activityId = uuidV7(),
    addressing = {
      to: [PUBLIC_IRI],
      cc: [`https://test-instance.drfed.org/users/${localActorId}/followers`],
    },
    ...object
  } of Array.isArray(values) ? values : [values]) {
    await promoteResource(
      db,
      iri,
      "object",
      async (tx, resource) => {
        const [row] = await tx
          .insert(schema.objects)
          .values({ ...object, id: resource.id })
          .returning();
        if (row == null) throw new Error("Missing seeded object.");
        await storeAddressing(tx, resource.id, addressing);
        const actor = await tx.query.actors.findFirst({
          where: { id: row.actorId },
          with: { instance: true },
        });
        if (actor == null) throw new Error("Missing seeded actor.");
        await promoteResource(
          tx,
          `https://${actor.instance.host}/ap/creates/${row.id}`,
          "activity",
          async (inner, activity) => {
            await inner.insert(schema.activities).values({
              id: activity.id,
              type: "Create",
              actorId: row.actorId,
              objectId: row.id,
              published: row.published,
            });
            await storeAddressing(inner, activity.id, addressing);
            await addActorCollectionItem(
              inner,
              row.actorId,
              "outbox",
              activity.id,
            );
          },
          activityId,
        );
      },
      object.id,
    );
  }
}
