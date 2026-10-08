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
import { validateUuid } from "@drfed/models/uuid";
import type {
  Context,
  Federation,
  FederationBuilder,
  TaskDefinition,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";

import { ensureActorKeyPairs } from "./actor-key.ts";

interface Payload {
  identifier: string;
}
type Handle = TaskDefinition<unknown, Payload>;
const builders = new WeakMap<FederationBuilder<unknown>, Handle>();
const handles = new WeakMap<Federation<unknown>, Handle>();
const logger = getLogger(["drfed", "federation", "actor-key"]);
const taskSchema: Handle["schema"] = {
  "~standard": {
    version: 1,
    vendor: "drfed",
    validate(value) {
      if (
        typeof value === "object" &&
        value != null &&
        "identifier" in value &&
        typeof value.identifier === "string" &&
        validateUuid(value.identifier)
      ) {
        return { value: { identifier: value.identifier } };
      }
      return { issues: [{ message: "Expected an actor UUID." }] };
    },
  },
};
export function registerActorKeyTask(
  builder: FederationBuilder<unknown>,
  db: Database,
): void {
  const handle = builder.defineTask("drfed.ensureActorKeyPairs", {
    schema: taskSchema,
    retryPolicy: () => null,
    async handler(ctx, data) {
      await ensureActorKeyPairs(db, ctx, data.identifier);
    },
  });
  builders.set(builder, handle);
}
export function attachActorKeyTask(
  builder: FederationBuilder<unknown>,
  federation: Federation<unknown>,
  enabled: boolean,
): void {
  const handle = builders.get(builder);
  if (enabled && handle != null) handles.set(federation, handle);
}
/** Schedule expendable prewarming after actor creation has committed. */
export async function enqueueActorKeyGeneration(
  ctx: Context<unknown>,
  identifiers: readonly string[],
): Promise<void> {
  const handle = handles.get(ctx.federation);
  if (handle == null || identifiers.length === 0) return;
  try {
    await ctx.enqueueTaskMany(
      handle,
      identifiers.map((identifier) => ({ identifier })),
    );
  } catch {
    logger.warn("Could not schedule actor key prewarming.");
  }
}
