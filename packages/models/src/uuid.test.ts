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

import { type Uuid, areUuidsEqual, uuidV7 } from "@drfed/models/uuid";

it("areUuidsEqual()", () => {
  assert.ok(
    areUuidsEqual(
      "550e8400-e29b-41d4-a716-446655440000",
      "550e8400-e29b-41d4-a716-446655440000",
    ),
  );
  assert.ok(
    areUuidsEqual(
      "550e8400-e29b-41d4-a716-446655440000",
      "550E8400-E29B-41D4-A716-446655440000",
    ),
  );
  assert.ok(
    !areUuidsEqual(
      "550e8400-e29b-41d4-a716-446655440000",
      "550e8400-e29b-41d4-a716-446655440001",
    ),
  );
  assert.ok(
    !areUuidsEqual(
      "550e8400-e29b-41d4-a716-446655440000",
      "not-a-uuid" as Uuid,
    ),
  );
});

it("generates distinct UUIDv7 identifiers", () => {
  const first = uuidV7();
  const second = uuidV7();
  assert.match(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assert.notEqual(first, second);
});
