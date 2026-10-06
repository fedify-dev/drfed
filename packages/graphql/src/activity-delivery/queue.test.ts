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

// These tests run Fedify's own delivery and outbox worker against an inbox
// served on a local port.
// oxlint-disable max-statements no-await-in-loop
import assert from "node:assert/strict";
import { it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import {
  deliverActivity,
  queuedSettlements,
} from "@drfed/graphql/activity-delivery";
import createFederation from "@drfed/graphql/federation";
import type { Database } from "@drfed/models";
import {
  type Context,
  InProcessMessageQueue,
  MemoryKvStore,
  type MessageQueue,
  generateCryptoKeyPair,
} from "@fedify/fedify";
import { type Activity, Create, type Recipient } from "@fedify/vocab";

import { withTemporaryDatabase } from "../harness.test.ts";
import { localActorId, seedLocalActor } from "../seed.test.ts";
import { withInbox } from "./remote.test.ts";

const origin = "https://test-instance.drfed.org";
const localActorIri = new URL(`${origin}/users/${localActorId}`);
const alice = new URL("https://remote.example/users/alice");

/**
 * Run with a temporary database holding the local actor deliveries are from.
 * @returns The result of the run.
 */
async function withSeededDatabase<T>(
  run: (db: Database) => Promise<T>,
): Promise<T> {
  return await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    return await run(db);
  });
}

const findDeliveries = (db: Database, activityIri: string) =>
  db.query.activityDeliveries.findMany({
    where: { activityIri },
    orderBy: { created: "asc", id: "asc" },
    with: { attempts: { orderBy: { created: "asc", id: "asc" } } },
  });
type Delivery = Awaited<ReturnType<typeof findDeliveries>>[number];

const results = (delivery: Delivery | undefined) =>
  delivery?.attempts.map((attempt) => [
    attempt.succeeded,
    attempt.statusCode,
    attempt.responseBody,
  ]);

/**
 * Deliver one activity through Fedify to `inbox`, with `queue` if any, until
 * every delivery is settled for good.  The database holds the local actor.
 * @param activity What tells the activity from others delivered from the
 *                 same database.
 * @param retries How many times the worker may retry a failed attempt.
 * @param deliveries How many times to deliver the activity before the worker
 *                   starts.
 * @param algorithm The sender's key.  Fedify signs requests only with RSA.
 * @returns The deliveries, oldest first.
 */
async function deliver(
  db: Database,
  inbox: URL,
  {
    activity: name = "1",
    queue,
    retries = 3,
    deliveries = 1,
    algorithm = "Ed25519",
  }: {
    readonly activity?: string;
    readonly queue?: MessageQueue;
    readonly retries?: number;
    readonly deliveries?: number;
    readonly algorithm?: "Ed25519" | "RSASSA-PKCS1-v1_5";
  } = {},
): Promise<Delivery[]> {
  const federation = await createFederation(db, {
    kv: new MemoryKvStore(),
    allowPrivateAddress: true,
    ...(queue == null ? {} : { queue, manuallyStartQueue: true }),
    circuitBreaker: false,
    outboxRetryPolicy: ({ attempts }) =>
      attempts < retries ? Temporal.Duration.from({ milliseconds: 1 }) : null,
  });
  // Local key pairs arrive with #87; sign with a key of the test's own.
  const { privateKey } = await generateCryptoKeyPair(algorithm);
  const key = { keyId: new URL(`${localActorIri.href}#key`), privateKey };
  const ctx: Context<unknown> = new Proxy(
    federation.createContext(new URL(origin), undefined),
    {
      get(target, property) {
        return property === "sendActivity"
          ? (_sender: unknown, recipients: Recipient[], activity: Activity) =>
              target.sendActivity(key, recipients, activity)
          : Reflect.get(target, property);
      },
    },
  );
  const activity = new Create({
    id: new URL(`${origin}/activity/${name}`),
    actor: localActorIri,
  });
  const recipient = { id: alice, inboxId: inbox };
  for (let count = 0; count < deliveries; count += 1) {
    await deliverActivity(
      db,
      ctx,
      { identifier: localActorId },
      recipient,
      activity,
    )
      // A synchronous failure is thrown as well as recorded.
      .catch(() => undefined);
  }
  const activityIri = activity.id?.href ?? "";
  if (queue == null) return await findDeliveries(db, activityIri);
  const controller = new AbortController();
  const worker = federation.startQueue(undefined, {
    signal: controller.signal,
  });
  try {
    for (let tries = 0; tries < 500; tries += 1) {
      const found = await findDeliveries(db, activityIri);
      const settled = found.every((delivery) =>
        ["sent", "permanently_failed", "abandoned"].includes(delivery.status),
      );
      if (found.length === deliveries && settled) return found;
      await sleep(10);
    }
    return assert.fail("The deliveries never settled.");
  } finally {
    controller.abort();
    await worker;
  }
}

it("keeps the status a remote inbox accepted a delivery with", async () => {
  await withSeededDatabase(async (db) => {
    const [delivery] = await withInbox([[202, ""]], (inbox) =>
      deliver(db, inbox),
    );
    assert.equal(delivery?.status, "sent");
    assert.equal(delivery?.statusCode, 202);
    assert.deepEqual(results(delivery), [[true, 202, null]]);
  });
});

it("keeps the status a redirected delivery ended with", async () => {
  // Fedify follows a redirect itself when it signs the request, and leaves it
  // to `fetch()` otherwise, which follows a 303 with a GET.
  await withSeededDatabase(async (db) => {
    for (const algorithm of ["Ed25519", "RSASSA-PKCS1-v1_5"] as const) {
      for (const redirect of [303, 307]) {
        for (const queued of [false, true]) {
          const [delivery] = await withInbox(
            [
              [redirect, "", "/moved"],
              [202, ""],
            ],
            (inbox) =>
              deliver(db, inbox, {
                activity: `${algorithm}-${redirect}-${queued}`,
                algorithm,
                ...(queued ? { queue: new InProcessMessageQueue() } : {}),
              }),
          );
          assert.equal(delivery?.status, "sent");
          assert.equal(delivery?.statusCode, 202);
          assert.deepEqual(results(delivery), [[true, 202, null]]);
        }
      }
    }
  });
});

it("follows a redirect to a location outside ASCII as Fedify reads it", async () => {
  // The header carries the UTF-8 bytes of the path, which Node.js writes from
  // the Latin-1 string of them.  Fedify follows the redirect itself whether it
  // signs the request or not, reading them back as Latin-1.
  const location = Buffer.from("/caf\u00e9", "utf8").toString("latin1");
  await withSeededDatabase(async (db) => {
    for (const algorithm of ["Ed25519", "RSASSA-PKCS1-v1_5"] as const) {
      const { delivery, paths } = await withInbox(
        [
          [307, "", location],
          [202, ""],
        ],
        async (inbox, received) => {
          const [delivered] = await deliver(db, inbox, {
            activity: algorithm,
            algorithm,
          });
          return {
            delivery: delivered,
            paths: received.map((request) => request.url),
          };
        },
      );
      assert.equal(delivery?.status, "sent");
      assert.equal(delivery?.statusCode, 202);
      assert.deepEqual(paths, ["/inbox", "/caf%C3%83%C2%A9"]);
    }
  });
});

it("settles a queued delivery the remote inbox accepts", async () => {
  await withSeededDatabase(async (db) => {
    const [delivery] = await withInbox([[202, ""]], (inbox) =>
      deliver(db, inbox, { queue: new InProcessMessageQueue() }),
    );
    assert.equal(delivery?.status, "sent");
    assert.deepEqual(results(delivery), [[true, 202, null]]);
    assert.ok(delivery?.completed != null);
  });
});

it("keeps every failed attempt of a queued delivery that is retried into success", async () => {
  await withSeededDatabase(async (db) => {
    const [delivery] = await withInbox(
      [
        [503, "busy"],
        [202, ""],
      ],
      (inbox) => deliver(db, inbox, { queue: new InProcessMessageQueue() }),
    );
    assert.deepEqual(results(delivery), [
      [false, 503, "busy"],
      [true, 202, null],
    ]);
    assert.equal(delivery?.error, null);
  });
});

it("records network failures, and abandons a delivery once retries run out", async () => {
  await withSeededDatabase(async (db) => {
    const [delivery] = await withInbox(null, (inbox) =>
      deliver(db, inbox, { queue: new InProcessMessageQueue(), retries: 1 }),
    );
    assert.deepEqual(results(delivery), [
      [false, null, null],
      [false, null, null],
    ]);
    for (const attempt of delivery?.attempts ?? []) {
      assert.match(attempt.error ?? "", /ECONNREFUSED/u);
    }
  });
});

it("retries by Fedify's policy even with a queue that retries natively", async () => {
  await withSeededDatabase(async (db) => {
    const queue = new InProcessMessageQueue();
    Object.defineProperty(queue, "nativeRetrial", { value: true });
    const [delivery] = await withInbox(
      [
        [503, "busy"],
        [503, "busy"],
      ],
      (inbox) => deliver(db, inbox, { queue, retries: 1 }),
    );
    assert.deepEqual(results(delivery), [
      [false, 503, "busy"],
      [false, 503, "busy"],
    ]);
  });
});

it("settles a permanent failure without retrying it", async () => {
  await withSeededDatabase(async (db) => {
    const [delivery] = await withInbox([[410, "gone"]], (inbox) =>
      deliver(db, inbox, { queue: new InProcessMessageQueue() }),
    );
    assert.equal(delivery?.status, "permanently_failed");
    assert.deepEqual(results(delivery), [[false, 410, "gone"]]);
    assert.equal(delivery?.statusCode, 410);
  });
});

it("settles each delivery of an activity sent twice to the same inbox", async () => {
  await withSeededDatabase(async (db) => {
    // The worker takes messages in order, so both deliveries are pending when
    // their retries arrive: the first retry is refused for good.
    const [first, second] = await withInbox(
      [
        [503, "busy"],
        [503, "busy"],
        [410, "gone"],
        [202, ""],
      ],
      (inbox) =>
        deliver(db, inbox, {
          queue: new InProcessMessageQueue(),
          retries: 1,
          deliveries: 2,
        }),
    );
    assert.equal(first?.status, "permanently_failed");
    assert.deepEqual(results(first), [
      [false, 503, "busy"],
      [false, 410, "gone"],
    ]);
    assert.equal(second?.status, "sent");
    assert.deepEqual(results(second), [
      [false, 503, "busy"],
      [true, 202, null],
    ]);
  });
});

it("translates what the worker reported into settlements", () => {
  const attempt = {
    activityIri: `${origin}/activity/1`,
    inboxUrl: "https://remote.example/inbox",
  };
  const failure = { statusCode: 503, error: "busy", responseBody: null };
  const expired = {
    statusCode: null,
    error: "Circuit breaker held activity expired.",
    responseBody: null,
  };
  assert.deepEqual(
    queuedSettlements({ ...attempt, sent: true, statusCode: 202 }),
    [{ status: "sent", attempted: true, statusCode: 202 }],
  );
  // Held back by the circuit breaker before sending: nothing was attempted.
  assert.deepEqual(queuedSettlements(attempt), []);
  // Dropped by the circuit breaker before sending.
  assert.deepEqual(queuedSettlements({ ...attempt, permanent: expired }), [
    { ...expired, status: "permanently_failed", attempted: false },
  ]);
  // Failed and retried, or held back after failing.
  for (const outcomes of [["retried"], []]) {
    assert.deepEqual(queuedSettlements({ ...attempt, failure, outcomes }), [
      { ...failure, status: "failed", attempted: true },
    ]);
  }
  assert.deepEqual(
    queuedSettlements({ ...attempt, failure, outcomes: ["abandoned"] }),
    [{ ...failure, status: "abandoned", attempted: true }],
  );
  // Failed, then dropped because the circuit breaker held it too long.
  assert.deepEqual(
    queuedSettlements({
      ...attempt,
      failure,
      permanent: expired,
      outcomes: ["abandoned"],
    }),
    [
      { ...failure, status: "failed", attempted: true },
      { ...expired, status: "permanently_failed", attempted: false },
    ],
  );
});
