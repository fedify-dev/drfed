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

import { hashSecret } from "./auth/hash.ts";

export const accepted = new Date("2026-08-04T00:00:00.000Z");
export const created = new Date("2026-08-04T00:00:00.000Z");
export const expires = new Date("2030-08-04T00:00:00.000Z");
export const ok = 200;

export const accountId = "00000000-0000-4000-8000-000000000001";
export const localInstanceId = "00000000-0000-4000-8000-000000000101";
export const remoteInstanceId = "00000000-0000-4000-8000-000000000102";
export const localActorId = "00000000-0000-4000-8000-000000000201";
export const remoteActorId = "00000000-0000-4000-8000-000000000202";
export const sessionId = "00000000-0000-4000-8000-000000000301";
export const accessToken = "test-access-token";

export function globalId(
  type: "Actor" | "Instance" | "Object",
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
  await db.insert(schema.actors).values({
    id: localActorId,
    localId: localActorId,
    instanceId: localInstanceId,
    type: "Person",
    username: "alice",
    iri: `https://test-instance.drfed.org/users/${localActorId}`,
    inboxUrl: `https://test-instance.drfed.org/users/${localActorId}/inbox`,
    outboxUrl: `https://test-instance.drfed.org/users/${localActorId}/outbox`,
    avatarUrl: `https://test-instance.drfed.org/users/${localActorId}/avatar/avatar.png`,
    followersUrl: `https://test-instance.drfed.org/users/${localActorId}/followers`,
    followingUrl: `https://test-instance.drfed.org/users/${localActorId}/following`,
    headerUrl: `https://test-instance.drfed.org/users/${localActorId}/header/header.png`,
    profileUrl: "https://test-instance.drfed.org/@alice",
    featuredUrl: `https://test-instance.drfed.org/users/${localActorId}/featured`,
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
  await db.insert(schema.actors).values({
    id: remoteActorId,
    instanceId: remoteInstanceId,
    type: "Service",
    username: "bob",
    iri: "https://remote.example.com/users/bob",
    inboxUrl: "https://remote.example.com/users/bob/inbox",
    outboxUrl: "https://remote.example.com/users/bob/outbox",
    avatarUrl: "https://remote.example.com/users/bob/avatar.png",
    followersUrl: "https://remote.example.com/users/bob/followers",
    followingUrl: "https://remote.example.com/users/bob/following",
    headerUrl: "https://remote.example.com/users/bob/header.png",
    profileUrl: "https://remote.example.com/@bob",
    featuredUrl: "https://remote.example.com/users/bob/featured",
    created,
  });
}
