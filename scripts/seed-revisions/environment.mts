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

// Keep dependent database writes sequential.
// oxlint-disable no-await-in-loop

import createFederation from "@drfed/federation";
import type { LocalWriteEnvironment } from "@drfed/federation/local-write";
import { createYogaServer } from "@drfed/graphql";
import {
  type Database,
  migrate,
  openPersistentPglite,
  relations,
  schema,
} from "@drfed/models";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";
import { MemoryKvStore } from "@fedify/fedify";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

const SLUG_A = "seed-a";
const SLUG_B = "seed-b";
const ACCOUNTS = [
  { key: "alice", name: "Alice", email: "alice@example.com", admin: false },
  { key: "bob", name: "Bob", email: "bob@example.com", admin: false },
  { key: "admin", name: "Admin", email: "admin@example.com", admin: true },
] as const;

/** An account the seed created, with an access token of its session. */
export interface Member {
  readonly accountId: Uuid;
  readonly name: string;
  readonly email: string;
  readonly token: string;
}

/** A local instance with its one member and one actor. */
export interface Workspace {
  readonly instanceId: Uuid;
  readonly host: string;
  readonly actorId: Uuid;
  readonly actorIri: string;
  /** Generated at random, so the report names it. */
  readonly actorUsername: string;
  readonly member: Member;
}

/** A GraphQL response body. */
export interface GraphqlBody {
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly data?: Record<string, any>;
  readonly errors?: readonly unknown[];
}

/** Sends a GraphQL request as a member, or anonymously for null. */
export type GraphqlRequest = (
  member: Member | null,
  query: string,
  variables?: Record<string, unknown>,
) => Promise<GraphqlBody>;

export interface SeedEnvironment {
  readonly db: Database;
  readonly write: LocalWriteEnvironment;
  readonly graphql: GraphqlRequest;
  readonly alice: Workspace;
  readonly bob: Workspace;
  readonly admin: Member;
  close(): Promise<void>;
}

/**
 * Encodes a Relay global ID.
 * @returns The ID.
 */
export const globalId = (type: string, id: string): string =>
  Buffer.from(`${type}:${id}`).toString("base64");

const hashToken = async (token: string): Promise<string> =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  ).toHex();

async function createMembers(db: Database): Promise<Record<string, Member>> {
  const created = Temporal.Now.instant();
  const members: Record<string, Member> = {};
  for (const { key, name, email, admin } of ACCOUNTS) {
    const accountId = uuidV7();
    const token = crypto
      .getRandomValues(new Uint8Array(32))
      .toBase64({ alphabet: "base64url", omitPadding: true });

    await db
      .insert(schema.accounts)
      .values({ id: accountId, email, name, admin, created });
    await db.insert(schema.sessions).values({
      id: uuidV7(),
      accountId,
      tokenHash: await hashToken(token),
    });
    members[key] = { accountId, name, email, token };
  }
  return members;
}

async function createWorkspace(
  db: Database,
  graphql: GraphqlRequest,
  member: Member,
  slug: string,
): Promise<Workspace> {
  const mutate = async (query: string, variables: Record<string, unknown>) => {
    const body = await graphql(member, query, variables);
    if (body.errors != null) throw new Error(JSON.stringify(body.errors));
  };
  await mutate(
    "mutation($slug: String!) { createInstance(slug: $slug) { __typename } }",
    { slug },
  );
  const [instance] = await db
    .select({ id: schema.instances.id, host: schema.instances.host })
    .from(schema.instances)
    .innerJoin(
      schema.localInstances,
      eq(schema.localInstances.id, schema.instances.localId),
    )
    .where(eq(schema.localInstances.slug, slug));
  if (instance == null) throw new Error(`Instance ${slug} was not created.`);
  await mutate(
    `mutation($instance: ID!) {
      generateActors(instance: $instance, size: 1) { __typename }
    }`,
    { instance: globalId("Instance", instance.id) },
  );
  const [actor] = await db
    .select({
      id: schema.actors.id,
      iri: schema.resources.iri,
      username: schema.actors.username,
    })
    .from(schema.actors)
    .innerJoin(schema.resources, eq(schema.resources.id, schema.actors.id))
    .where(eq(schema.actors.instanceId, instance.id));
  if (actor == null) throw new Error(`No actor was created on ${slug}.`);
  return {
    instanceId: instance.id,
    host: instance.host,
    actorId: actor.id,
    actorIri: actor.iri,
    actorUsername: actor.username ?? "",
    member,
  };
}

/**
 * Opens the PGlite store, migrates it, and creates the accounts, instances
 * and actors every case shares.  A store that was seeded before is refused,
 * because revisions cannot be replaced.
 * @returns The environment; close it when done.
 */
export async function openSeedEnvironment(
  dataPath: string,
  rootOrigin: URL,
): Promise<SeedEnvironment> {
  const store = await openPersistentPglite(dataPath);
  try {
    await store.ready;
    const { client } = store;
    await migrate({ credentials: { driver: "pglite", client } });
    const db: Database = drizzle({ client, relations, schema });
    const seeded = await db.$count(
      schema.localInstances,
      eq(schema.localInstances.slug, SLUG_A),
    );
    if (seeded > 0) {
      throw new Error(
        `${dataPath} is already seeded.  Revisions are immutable, so ` +
          "remove the directory and run the seed again.",
      );
    }
    const federation = await createFederation(db, { kv: new MemoryKvStore() });
    const yoga = createYogaServer(db, federation, {
      rootOrigin,
      loginOrigins: new Set(),
    });
    const endpoint = new URL("/graphql", rootOrigin).href;
    const graphql: GraphqlRequest = async (member, query, variables = {}) => {
      const response = await yoga.fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(member == null
            ? {}
            : { authorization: `Bearer ${member.token}` }),
        },
        body: JSON.stringify({ query, variables }),
      });
      return (await response.json()) as GraphqlBody;
    };
    const members = await createMembers(db);
    const { alice, bob, admin } = members;
    if (alice == null || bob == null || admin == null) {
      throw new Error("Missing a seeded account.");
    }
    return {
      db,
      graphql,
      write: {
        db,
        federation,
        rootOrigin,
        previewKey: await crypto.subtle.generateKey(
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign", "verify"],
        ),
      },
      alice: await createWorkspace(db, graphql, alice, SLUG_A),
      bob: await createWorkspace(db, graphql, bob, SLUG_B),
      admin,
      close: () => store.close(),
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}
