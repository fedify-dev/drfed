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

// oxlint-disable no-await-in-loop
import type {
  MessageQueue,
  MessageQueueEnqueueOptions,
  MessageQueueListenOptions,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["drfed", "federation", "task-queue"]);

/**
 * Bounded, ephemeral FIFO transport for immediate key prewarming only.
 * Fedify owns the message codec and task dispatch. Dropped warmups are repaired
 * by lazy key generation. No polling timers or retained abort listeners.
 */
export class KeyGenerationQueue implements MessageQueue {
  readonly nativeRetrial = false;
  readonly nativeDeduplication = false;
  readonly atomicEnqueueMany = true;
  #messages: unknown[] = [];
  #wake: (() => void) | undefined;
  #closed = false;
  #listening = false;
  #dropped = 0;
  readonly #capacity: number;
  constructor(capacity = 1024) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Invalid task queue capacity.");
    }
    this.#capacity = capacity;
  }
  /** Number of expendable messages discarded due to capacity or shutdown.
   * @returns The cumulative dropped message count.
   */
  get dropped(): number {
    return this.#dropped;
  }
  enqueue(
    message: unknown,
    options?: MessageQueueEnqueueOptions,
  ): Promise<void> {
    return this.enqueueMany([message], options);
  }
  enqueueMany(
    messages: readonly unknown[],
    options?: MessageQueueEnqueueOptions,
  ): Promise<void> {
    if (
      options?.delay != null &&
      Temporal.Duration.from(options.delay).sign !== 0
    ) {
      return Promise.reject(
        new TypeError("Key prewarming does not support delayed messages."),
      );
    }
    if (
      this.#closed ||
      this.#messages.length + messages.length > this.#capacity
    ) {
      this.#dropped += messages.length;
      return Promise.resolve();
    }
    this.#messages.push(...messages);
    this.#wake?.();
    return Promise.resolve();
  }
  getDepth() {
    return Promise.resolve({
      queued: this.#messages.length,
      ready: this.#messages.length,
      delayed: 0,
    });
  }
  async listen(
    handler: (message: unknown) => void | Promise<void>,
    options?: MessageQueueListenOptions,
  ): Promise<void> {
    if (this.#listening || this.#closed) {
      throw new Error("Key task queue cannot be restarted.");
    }
    this.#listening = true;
    const signal = options?.signal;
    try {
      // The AbortSignal is changed by the worker owner.
      // oxlint-disable-next-line no-unmodified-loop-condition
      while (!signal?.aborted) {
        if (this.#messages.length === 0) {
          const wake = Promise.withResolvers<void>();
          this.#wake = () => wake.resolve();
          signal?.addEventListener("abort", this.#wake, { once: true });
          try {
            await wake.promise;
          } finally {
            signal?.removeEventListener("abort", this.#wake);
            this.#wake = undefined;
          }
          continue;
        }
        const message = this.#messages.shift();
        try {
          await handler(message);
        } catch {
          logger.error("A key prewarming message failed.");
        }
      }
    } finally {
      this.#closed = true;
      this.#dropped += this.#messages.length;
      this.#messages = [];
      this.#wake = undefined;
    }
  }
}
