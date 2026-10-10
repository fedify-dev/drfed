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

import type { Database, Transaction } from "./db.ts";
import { type Instance, instances } from "./schema.ts";
import { uuidV7 } from "./uuid.ts";

/**
 * Returns the remote instance of a host, registering it if it is new.  The
 * host is compared as given, so it must already be canonical.
 * @returns The remote instance, or null when the host is a local instance's.
 */
export async function ensureRemoteInstance(
  tx: Database | Transaction,
  host: string,
): Promise<Instance | null> {
  const [inserted] = await tx
    .insert(instances)
    .values({ id: uuidV7(), host })
    .onConflictDoNothing({ target: instances.host })
    .returning();
  // A concurrent insertion can win; a separate statement sees that committed
  // row under PostgreSQL's READ COMMITTED.
  const instance =
    inserted ??
    (await tx.query.instances.findFirst({ where: { host } })) ??
    null;
  if (instance == null) throw new Error("Instance insertion returned no row.");
  return instance.localId == null ? instance : null;
}
