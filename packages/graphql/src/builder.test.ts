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
import { describe, it } from "node:test";

import { schema } from "@drfed/graphql/schema";
import { Kind, isScalarType } from "graphql";

describe("DateTime scalar", () => {
  it("preserves microseconds and normalizes offsets for variables and literals", () => {
    const scalar = schema.getType("DateTime");
    assert.ok(isScalarType(scalar));
    const input = "2026-09-14T17:30:00.123456+05:30";
    const expected = Temporal.Instant.from("2026-09-14T12:00:00.123456Z");
    for (const instant of [
      scalar.parseValue(input),
      scalar.parseLiteral({ kind: Kind.STRING, value: input }, {}),
    ]) {
      assert.ok(instant instanceof Temporal.Instant);
      assert.equal(instant.epochNanoseconds, expected.epochNanoseconds);
      assert.equal(scalar.serialize(instant), expected.toString());
    }
  });

  it("rejects invalid instants, non-string inputs and non-Instant outputs", () => {
    const scalar = schema.getType("DateTime");
    assert.ok(isScalarType(scalar));
    for (const input of [
      0,
      {},
      "invalid",
      "2026-09-14",
      "2026-09-14T12:00:00",
    ]) {
      assert.throws(() => scalar.parseValue(input));
    }
    assert.throws(() =>
      scalar.parseLiteral({ kind: Kind.INT, value: "0" }, {}),
    );
    assert.throws(() => scalar.serialize("2026-09-14T12:00:00Z"));
  });
});
