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

// Polling waits for lock states one step at a time.
// oxlint-disable no-await-in-loop, promise/avoid-new

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";

import createFederation from "@drfed/federation";
import {
  type CommitOutcome,
  type CreateRequest,
  type LocalWriteEnvironment,
  commitLocalWrite,
  previewLocalWrite,
} from "@drfed/federation/local-write";
import { type Database, migrate, relations, schema } from "@drfed/models";
import { PUBLIC_IRI } from "@drfed/models/resource";
import type { Uuid } from "@drfed/models/uuid";
import { MemoryKvStore } from "@fedify/fedify";
import { describe, it } from "@logtape/testing-node/autoload";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  created,
  localActorId,
  localInstanceId,
  seedActors,
  seedLocalActor,
} from "./seed.test.ts";

// This service is an isolated, author-owned test cluster.
// oxlint-disable-next-line node/no-process-env
const postgresUrl = process.env.DRFED_TEST_POSTGRES_URL;
const accountId = "00000000-0000-4000-8000-000000000301" as Uuid;
const secondActorId = "00000000-0000-4000-8000-000000000203" as Uuid;
const principal = { accountId };

interface Connection {
  readonly db: Database;
  readonly client: postgres.Sql;
}

function connect(url: string): Connection {
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  return { db: drizzle({ client, schema, relations }), client };
}

/**
 * Runs a callback against a fresh database of the test cluster, with a
 * member who may write as the seeded local actor.
 * @returns What the callback returns.
 */
async function withDatabase<T>(
  run: (url: string, env: LocalWriteEnvironment) => Promise<T>,
): Promise<T> {
  assert.ok(postgresUrl, "An isolated PostgreSQL cluster is required.");
  const name = `drfed_local_write_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(postgresUrl, { max: 1, onnotice: () => undefined });
  const url = new URL(postgresUrl);
  url.pathname = `/${name}`;
  let main: Connection | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    await migrate({ credentials: { url: url.href } });
    main = connect(url.href);
    await seedLocalActor(main.db, { keys: false });
    await main.db.insert(schema.accounts).values({
      id: accountId,
      email: "member@example.com",
      name: "Member",
      created,
    });
    await main.db.insert(schema.instanceMembers).values({
      accountId,
      instanceId: localInstanceId,
      accepted: created,
      created,
    });
    const env: LocalWriteEnvironment = {
      db: main.db,
      federation: await createFederation(main.db, { kv: new MemoryKvStore() }),
      rootOrigin: new URL("https://drfed.org"),
      previewKey: await crypto.subtle.generateKey(
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    };
    return await run(url.href, env);
  } finally {
    await main?.client.end();
    await admin.unsafe(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
      [name],
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
}

/** Seeds a second local actor of the member's instance. */
async function seedSecondActor(db: Database): Promise<void> {
  await db.insert(schema.localActors).values({ id: secondActorId });
  await seedActors(
    db,
    {
      id: secondActorId,
      localId: secondActorId,
      instanceId: localInstanceId,
      type: "Person",
      username: "bob",
      iri: `https://test-instance.drfed.org/users/${secondActorId}`,
      inboxUrl: `https://test-instance.drfed.org/users/${secondActorId}/inbox`,
      profileUrl: "https://test-instance.drfed.org/@bob",
      created,
    },
    { keys: false },
  );
}

function note(
  to: readonly string[],
  actorId: Uuid = localActorId,
): CreateRequest {
  return {
    operation: "create",
    actorId,
    document: {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Note",
      content: "x",
      to: [...to],
    },
    resources: [{ path: [], kind: "object" }],
  };
}

async function previewToken(
  env: LocalWriteEnvironment,
  request: CreateRequest,
): Promise<string> {
  const preview = await previewLocalWrite(env, principal, request);
  assert.ok(preview.ok);
  return preview.preview.token;
}

const options = { skip: postgresUrl == null };

describe("commitLocalWrite() on PostgreSQL", () => {
  it(
    "saves a token's resources once when two commits race",
    options,
    async () => {
      await withDatabase(async (url, env) => {
        const request = note([PUBLIC_IRI]);
        const token = await previewToken(env, request);
        const connections = [connect(url), connect(url)];
        try {
          const outcomes = await Promise.all(
            connections.map((connection) =>
              commitLocalWrite(
                { ...env, db: connection.db },
                principal,
                request,
                {
                  previewToken: token,
                },
              ),
            ),
          );
          assert.deepEqual(outcomes.map(({ ok }) => ok).toSorted(), [
            false,
            true,
          ]);
          const failed = outcomes.find(({ ok }) => !ok);
          assert.ok(failed != null && !failed.ok);
          assert.equal(failed.error.type, "resource_conflict");
          assert.equal(await env.db.$count(schema.resourceRevisions), 1);
        } finally {
          await Promise.all(connections.map(({ client }) => client.end()));
        }
      });
    },
  );

  it(
    "registers shared recipients in one order, so opposite orders do not deadlock",
    options,
    async () => {
      await withDatabase(async (url, env) => {
        // Two actors, so that the writers do not wait for each other on one
        // actor's lock.  Recipients sort in their array order.
        await seedSecondActor(env.db);
        const recipients = Array.from(
          { length: 20 },
          (_, index) =>
            `https://remote.example/users/${String(index).padStart(2, "0")}`,
        );
        const requests = [
          note(recipients),
          note(recipients.toReversed(), secondActorId),
        ];
        const tokens = await Promise.all(
          requests.map((request) => previewToken(env, request)),
        );
        const holder = connect(url);
        const connections = [connect(url), connect(url)];
        try {
          let pending: Promise<CommitOutcome[]> | undefined;
          // Holding a recipient in the middle stops both writers there.  In
          // opposite orders, each would by then hold the recipients the other
          // needs next, and releasing it would deadlock them.
          await holder.client.begin(async (tx) => {
            await tx`
              INSERT INTO resources (id, iri, kind)
              VALUES (${randomUUID()}, ${recipients[10]!}, 'unknown')`;
            pending = Promise.all(
              connections.map((connection, index) =>
                commitLocalWrite(
                  { ...env, db: connection.db },
                  principal,
                  requests[index]!,
                  { previewToken: tokens[index]! },
                ),
              ),
            );
            for (let attempt = 0; attempt < 100; attempt += 1) {
              const [row] = await tx`
              SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted`;
              if ((row?.waiting ?? 0) >= 2) break;
              await new Promise((resolve) => {
                setTimeout(resolve, 50);
              });
            }
          });
          const outcomes = await pending!;
          assert.ok(outcomes.every(({ ok }) => ok));
          assert.equal(await env.db.$count(schema.resourceRevisions), 2);
        } finally {
          await holder.client.end();
          await Promise.all(connections.map(({ client }) => client.end()));
        }
      });
    },
  );

  it(
    "sees a membership revoked while it waited for the actor's lock",
    options,
    async () => {
      await withDatabase(async (url, env) => {
        const request = note([PUBLIC_IRI]);
        const token = await previewToken(env, request);
        const holder = connect(url);
        const writer = connect(url);
        try {
          let pending: ReturnType<typeof commitLocalWrite> | undefined;
          await holder.client.begin(async (tx) => {
            await tx`SELECT id FROM actors WHERE id = ${localActorId} FOR UPDATE`;
            pending = commitLocalWrite(
              { ...env, db: writer.db },
              principal,
              request,
              { previewToken: token },
            );
            // Wait until the writer is blocked on the actor row.
            for (let attempt = 0; attempt < 100; attempt += 1) {
              const [row] = await tx`
              SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted`;
              if ((row?.waiting ?? 0) > 0) break;
              await new Promise((resolve) => {
                setTimeout(resolve, 50);
              });
            }
            await tx`DELETE FROM instance_members WHERE account_id = ${accountId}`;
          });
          // The writer goes on only once the revocation has committed.
          const outcome = await pending;
          assert.ok(outcome != null && !outcome.ok);
          assert.equal(outcome.error.type, "actor_not_found");
          assert.equal(await env.db.$count(schema.resourceRevisions), 0);
        } finally {
          await holder.client.end();
          await writer.client.end();
        }
      });
    },
  );
});
