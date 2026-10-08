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
import { it } from "node:test";

import { privateKeySafeLogger } from "@drfed/drfed/query-logger";

it("never forwards key parameters to the ordinary SQL logger", () => {
  const calls: unknown[] = [];
  const logger = privateKeySafeLogger({
    logQuery(query, params) {
      calls.push([query, params]);
    },
  });
  logger.logQuery('insert into "local_actor_keys" values ($1)', [
    "PRIVATE_SECRET",
  ]);
  logger.logQuery('select * from "local_actor_keys"', []);
  logger.logQuery("INSERT INTO LOCAL_ACTOR_KEYS VALUES ($1)", [
    "PRIVATE_SECRET",
  ]);
  logger.logQuery("insert into Local_Actor_Keys values ($1)", [
    "PRIVATE_SECRET",
  ]);
  assert.deepEqual(calls, []);
  logger.logQuery("select $1", [42]);
  assert.deepEqual(calls, [["select $1", [42]]]);
});
