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

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { it } from "node:test";

import { KeyGenerationQueue } from "@drfed/federation/task-queue";

it("bounds complete batches and drops work after shutdown", async () => {
  const queue = new KeyGenerationQueue(2);
  await queue.enqueueMany([1, 2, 3]);
  assert.equal(queue.dropped, 3);
  assert.equal((await queue.getDepth()).queued, 0);
  await queue.enqueueMany([1, 2]);
  const abort = new AbortController();
  const received: unknown[] = [];
  await queue.listen(
    (value) => {
      received.push(value);
      if (received.length === 2) abort.abort();
    },
    { signal: abort.signal },
  );
  assert.deepEqual(received, [1, 2]);
  await queue.enqueue(4);
  assert.equal(queue.dropped, 4);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});
it("releases wait listeners through repeated wakeups and idle abort", async () => {
  const queue = new KeyGenerationQueue();
  const abort = new AbortController();
  let notification = Promise.withResolvers<void>();
  const worker = queue.listen(() => notification.resolve(), {
    signal: abort.signal,
  });
  for (let index = 0; index < 100; index += 1) {
    // oxlint-disable-next-line no-await-in-loop
    await queue.enqueue(index);
    // oxlint-disable-next-line no-await-in-loop
    await notification.promise;
    notification = Promise.withResolvers<void>();
    assert.ok(getEventListeners(abort.signal, "abort").length <= 1);
  }
  abort.abort();
  await worker;
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});
it("waits for an active handler, continues after errors and rejects delays", async () => {
  const queue = new KeyGenerationQueue();
  const abort = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await queue.enqueueMany([1, 2]);
  const worker = queue.listen(
    async (value) => {
      if (value === 1) throw new Error("test failure");
      entered.resolve();
      await release.promise;
    },
    { signal: abort.signal },
  );
  await entered.promise;
  let finished = false;
  // oxlint-disable-next-line promise/prefer-await-to-then
  const settled = worker.then(() => {
    finished = true;
    return undefined;
  });
  abort.abort();
  await Promise.resolve();
  assert.equal(finished, false);
  release.resolve();
  await settled;
  await assert.rejects(
    queue.enqueue(3, { delay: Temporal.Duration.from({ seconds: 1 }) }),
    /delayed/u,
  );
});
it("closes an already-aborted queue and clears its buffered work", async () => {
  const queue = new KeyGenerationQueue();
  await queue.enqueue(1);
  await queue.listen(() => assert.fail(), { signal: AbortSignal.abort() });
  assert.equal(queue.dropped, 1);
  assert.equal((await queue.getDepth()).queued, 0);
});
