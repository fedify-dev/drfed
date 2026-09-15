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

import { migrate } from "@drfed/models/migrate";
import { isValidSlug } from "@drfed/models/slug";
import { uuidV7 } from "@drfed/models/uuid";
import { PGlite } from "@electric-sql/pglite";
import { describe, it } from "@logtape/testing-node/autoload";

describe("isValidSlug()", () => {
  it("accepts ordinary slugs", () => {
    for (const slug of ["abcd", "foo-bar", "a-b-c", "instance1", "0123"]) {
      assert.ok(isValidSlug(slug), slug);
    }
  });

  it("enforces the length bounds", () => {
    assert.equal(isValidSlug("abc"), false);
    assert.ok(isValidSlug("abcd"));
    assert.ok(isValidSlug("a".repeat(63)));
    assert.equal(isValidSlug("a".repeat(64)), false);
  });

  it("rejects leading and trailing hyphens", () => {
    for (const slug of ["-foo", "foo-", "-foo-", "----"]) {
      assert.equal(isValidSlug(slug), false, slug);
    }
  });

  it("allows xn-- A-labels", () => {
    // `xn--3e0b707e` is the Punycode encoding of `한국`.
    assert.ok(isValidSlug("xn--3e0b707e"));
    assert.ok(isValidSlug("xn--9t4b11yi5a"));
  });

  it("rejects other reserved LDH labels", () => {
    for (const slug of ["ab--cd", "00--11", "aa--bb-cc"]) {
      assert.equal(isValidSlug(slug), false, slug);
    }
  });

  it("rejects an xn-- label that is not decodable Punycode", () => {
    // The prefix alone is not enough.  A host name built from such a label
    // is not a URL at all, so an instance carrying it could never be reached.
    for (const slug of ["xn--a", "xn--aa", "xn--zzzz-"]) {
      assert.equal(isValidSlug(slug), false, slug);
    }
  });

  it("rejects a bare xn-- prefix", () => {
    // It ends with a hyphen, so it is not a valid label on its own.
    assert.equal(isValidSlug("xn--"), false);
  });

  it("rejects characters outside the label alphabet", () => {
    for (const slug of [
      "Foo-bar",
      "foo_bar",
      "foo.bar",
      "foo bar",
      "한국",
      "",
    ]) {
      assert.equal(isValidSlug(slug), false, JSON.stringify(slug));
    }
  });
});

// `isValidSlug()` restates the `local_instances_slug_check` constraint in
// TypeScript.  Nothing keeps the two in step automatically, so assert against
// a real database that they still agree.
describe("local_instances_slug_check", () => {
  it("agrees with isValidSlug()", async () => {
    const client = new PGlite();
    try {
      await migrate({ credentials: { driver: "pglite", client } });
      const slugs = [
        "foo-bar",
        "abcd",
        "xn--3e0b707e",
        "a".repeat(63),
        "abc",
        "-foo",
        "foo-",
        "ab--cd",
        "xn--",
        "Foo-bar",
      ];
      const results = await Promise.all(
        slugs.map(async (slug) => {
          try {
            await client.query(
              "INSERT INTO local_instances (id, slug, expires) " +
                "VALUES ($1, $2, now())",
              [uuidV7(), slug],
            );
            return { slug, constraint: null };
          } catch (e) {
            return {
              slug,
              constraint:
                e != null && typeof e === "object" && "constraint" in e
                  ? e.constraint
                  : undefined,
            };
          }
        }),
      );
      for (const { slug, constraint } of results) {
        assert.equal(constraint == null, isValidSlug(slug), slug);
        if (constraint != null) {
          assert.equal(constraint, "local_instances_slug_check", slug);
        }
      }
    } finally {
      await client.close();
    }
  });
});
