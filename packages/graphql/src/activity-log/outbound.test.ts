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

// oxlint-disable max-statements no-await-in-loop no-throw-literal
import assert from "node:assert/strict";
import { it } from "node:test";

import { deliverActivity, groupRecipients } from "@drfed/graphql/activity-log";
import createFederation from "@drfed/graphql/federation";
import type { Database } from "@drfed/models";
import {
  type Context,
  InProcessMessageQueue,
  MemoryKvStore,
  SendActivityError,
  type SendActivityOptions,
  generateCryptoKeyPair,
} from "@fedify/fedify";
import {
  type Activity,
  Create,
  PUBLIC_COLLECTION,
  type Recipient,
} from "@fedify/vocab";

import { withTemporaryDatabase } from "../harness.test.ts";
import { localActorId, seedLocalActor } from "../seed.test.ts";
import { withInbox } from "./remote.test.ts";

const origin = "https://test-instance.drfed.org";
const localActorIri = new URL(`${origin}/users/${localActorId}`);
const inboxId = new URL("https://remote.example/inbox");
const alice = { id: new URL("https://remote.example/users/alice"), inboxId };
const bob = { id: new URL("https://remote.example/users/bob"), inboxId };
const sender = { identifier: localActorId };
const create = (
  id: string,
  extra: ConstructorParameters<typeof Create>[0] = {},
) =>
  new Create({
    id: new URL(`${origin}/activity/${id}`),
    actor: localActorIri,
    ...extra,
  });

/**
 * A context whose `sendActivity()` is `send`, for a delivery whose outcome the
 * test decides.
 * @returns The context.
 */
async function createContext(
  db: Database,
  send: (activity: Activity, recipients: readonly Recipient[]) => Promise<void>,
): Promise<Context<unknown>> {
  const federation = await createFederation(db, { kv: new MemoryKvStore() });
  return new Proxy(federation.createContext(new URL(origin), undefined), {
    get(target, property) {
      return property === "sendActivity"
        ? (_sender: unknown, recipients: Recipient[], activity: Activity) =>
            send(activity, recipients)
        : Reflect.get(target, property);
    },
  });
}

/**
 * A context delivering through Fedify with a key of the test's own, since
 * local key pairs arrive with #87.  With a queue, its worker is never started.
 * @returns The context, and the activities passed to Fedify.
 */
async function createDeliveringContext(
  db: Database,
  {
    queue,
    ...options
  }: SendActivityOptions & { readonly queue?: InProcessMessageQueue } = {},
): Promise<{ readonly ctx: Context<unknown>; readonly passed: Activity[] }> {
  const federation = await createFederation(db, {
    kv: new MemoryKvStore(),
    ...(queue == null ? {} : { queue, manuallyStartQueue: true }),
  });
  const { privateKey } = await generateCryptoKeyPair("Ed25519");
  const key = { keyId: new URL(`${localActorIri.href}#key`), privateKey };
  const passed: Activity[] = [];
  const ctx = new Proxy(federation.createContext(new URL(origin), undefined), {
    get(target, property) {
      return property === "sendActivity"
        ? (_sender: unknown, recipients: Recipient[], activity: Activity) => {
            passed.push(activity);
            return target.sendActivity(key, recipients, activity, options);
          }
        : Reflect.get(target, property);
    },
  });
  return { ctx, passed };
}

const logs = (db: Database) =>
  db.query.activityLogs.findMany({ orderBy: { id: "asc" } });

it("keeps the outcome of an earlier attempt when a retry to the same inbox fails", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const activity = create("retried");
    for (const [statusCode, message, body] of [
      [503, "unavailable", "First"],
      [502, "bad gateway", "Second"],
    ] as const) {
      const ctx = await createContext(db, () =>
        Promise.reject(
          new SendActivityError(inboxId, statusCode, message, body),
        ),
      );
      await assert.rejects(
        deliverActivity(db, ctx, sender, alice, activity),
        SendActivityError,
      );
    }
    assert.deepEqual(
      (await logs(db)).map((log) => [
        log.status,
        log.statusCode,
        log.error,
        log.responseBody,
      ]),
      [
        ["failed", 503, "unavailable", "First"],
        ["failed", 502, "bad gateway", "Second"],
      ],
    );
  });
});

it("settles a delivery whose remote response holds text PostgreSQL cannot store", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const body = "error\u0000details";
    const ctx = await createContext(db, () =>
      Promise.reject(
        new SendActivityError(inboxId, 500, `Failed:\n${body}`, body),
      ),
    );
    await assert.rejects(
      deliverActivity(db, ctx, sender, alice, create("nul")),
      SendActivityError,
    );
    const [log] = await db.query.activityLogs.findMany({
      with: { attempts: true },
    });
    assert.deepEqual(
      [log?.status, log?.statusCode, log?.error, log?.responseBody],
      ["failed", 500, "Failed:\nerror\ufffddetails", "error\ufffddetails"],
    );
    assert.deepEqual(
      log?.attempts.map((attempt) => [
        attempt.succeeded,
        attempt.statusCode,
        attempt.responseBody,
      ]),
      [[false, 500, "error\ufffddetails"]],
    );
  });
});

it("logs every recipient of a shared inbox and strips blind recipients before delivery", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const { ctx, passed } = await createDeliveringContext(db);
    const activity = create("blind", {
      tos: [alice.id],
      btos: [new URL("urn:bto")],
      bccs: [bob.id],
    });
    const [log, ...rest] = await withInbox(
      [[202, ""]],
      async (inbox, received) => {
        const shared = { id: alice.id, inboxId: inbox };
        const other = { id: bob.id, inboxId: inbox };
        await deliverActivity(
          db,
          ctx,
          sender,
          [shared, other, shared],
          activity,
        );
        assert.equal(received.length, 1);
        const sent = JSON.parse(received[0]?.body ?? "") as Record<
          string,
          unknown
        >;
        assert.equal(sent.to, alice.id.href);
        assert.equal("bto" in sent, false);
        assert.equal("bcc" in sent, false);
        return await logs(db);
      },
    );
    assert.deepEqual(rest, []);
    assert.equal(log?.status, "sent");
    assert.equal(log?.statusCode, 202);
    assert.deepEqual(log?.recipientIris, [alice.id.href, bob.id.href]);
    assert.equal(log?.remoteActorIri, null);
    assert.match(log?.remoteHost ?? "", /^127\.0\.0\.1:\d+$/u);
    const payload = log?.payload as Record<string, unknown>;
    assert.equal(payload.to, alice.id.href);
    assert.equal("bto" in payload, false);
    assert.equal("bcc" in payload, false);
    assert.equal(passed.length, 1);
    assert.deepEqual(passed[0]?.btoIds, []);
    assert.deepEqual(passed[0]?.bccIds, []);
    assert.deepEqual(passed[0]?.toIds, [alice.id]);
    assert.deepEqual(activity.bccIds, [bob.id]);
    assert.deepEqual(await db.query.activityLogActors.findMany(), [
      {
        logId: log?.id,
        actorId: localActorId,
        inboxOwner: false,
        addressed: false,
        sender: true,
        viaCollectionIri: null,
      },
    ]);
  });
  assert.deepEqual(
    [
      ...groupRecipients(
        [
          alice,
          { id: localActorIri, inboxId: new URL(`${origin}/inbox`) },
          { id: PUBLIC_COLLECTION, inboxId },
          { id: bob.id, inboxId: null },
          { id: null, inboxId },
        ],
        localActorIri.href,
      ),
    ],
    [[inboxId.href, [alice]]],
  );
});

it("logs no delivery to a recipient Fedify leaves out for having no ID", async () => {
  for (const queue of [undefined, new InProcessMessageQueue()]) {
    await withTemporaryDatabase(async (db) => {
      await seedLocalActor(db);
      const { ctx } = await createDeliveringContext(db, {
        ...(queue == null ? {} : { queue }),
      });
      await withInbox([[202, ""]], async (inbox, received) => {
        const anonymous = { id: null, inboxId: inbox };
        const named = { id: alice.id, inboxId: inbox };
        await deliverActivity(db, ctx, sender, anonymous, create("anonymous"));
        assert.deepEqual(received, []);
        assert.deepEqual(await logs(db), []);
        // Sharing an inbox with a recipient Fedify delivers to changes nothing.
        await deliverActivity(
          db,
          ctx,
          sender,
          [anonymous, named],
          create("mixed"),
        );
        const [log, ...rest] = await logs(db);
        assert.deepEqual(rest, []);
        assert.deepEqual(log?.recipientIris, [alice.id.href]);
        assert.equal(log?.remoteActorIri, alice.id.href);
        assert.equal(log?.status, queue == null ? "sent" : "queued");
        assert.equal(received.length, queue == null ? 1 : 0);
      });
    });
  }
});

it("settles a delivery Fedify returns from without making", async () => {
  // Fedify leaves out every recipient at an excluded origin, and returns as if
  // it had delivered.
  for (const queue of [undefined, new InProcessMessageQueue()]) {
    await withTemporaryDatabase(async (db) => {
      await seedLocalActor(db);
      await withInbox([[202, ""]], async (inbox, received) => {
        const { ctx } = await createDeliveringContext(db, {
          ...(queue == null ? {} : { queue }),
          excludeBaseUris: [inbox],
        });
        const recipient = { id: alice.id, inboxId: inbox };
        await deliverActivity(db, ctx, sender, recipient, create("excluded"));
        assert.deepEqual(received, []);
        const [log] = await db.query.activityLogs.findMany({
          with: { attempts: true },
        });
        assert.equal(log?.status, "permanently_failed");
        assert.equal(log?.statusCode, null);
        assert.equal(log?.error, "Fedify made no delivery to the inbox.");
        assert.ok(log?.completed != null);
        assert.deepEqual(log?.attempts, []);
      });
    });
  }
});

it("leaves a delivery queued until the outbox worker attempts it", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const { ctx } = await createDeliveringContext(db, {
      queue: new InProcessMessageQueue(),
    });
    await deliverActivity(db, ctx, sender, alice, create("queued"));
    const [log] = await logs(db);
    assert.equal(log?.status, "queued");
    assert.equal(log?.completed, null);
    assert.equal(log?.remoteActorIri, alice.id.href);
  });
});
