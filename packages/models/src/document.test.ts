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
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  type DiagnosticReason,
  type FieldPath,
  diagnosticReasons,
  validateDocument,
} from "@drfed/models/document";

interface DraftFixture {
  readonly id: string;
  readonly input: unknown;
  readonly expected: {
    readonly complete: boolean;
    readonly diagnostics: readonly {
      readonly reason: DiagnosticReason;
      readonly path: FieldPath;
    }[];
  };
}

const { fixtures } = JSON.parse(
  await readFile(
    new URL(
      "../../../fixtures/document-validation/initial.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { fixtures: readonly DraftFixture[] };

const context = "https://www.w3.org/ns/activitystreams";
const like = {
  "@context": context,
  type: "Like",
  actor: "https://example.com/alice",
  object: "https://example.com/posts/42",
};

describe("validateDocument() initial Like/reference checks", () => {
  for (const id of ["root-number", "like-reference", "like-number"]) {
    it(`matches the ${id} draft fixture`, () => {
      const fixture = fixtures.find((entry) => entry.id === id);
      assert.ok(fixture, `Missing draft fixture: ${id}`);
      const original = structuredClone(fixture.input);
      const result = validateDocument(fixture.input);
      assert.equal(result.complete, fixture.expected.complete);
      assert.deepEqual(
        result.diagnostics.map(({ reason, path }) => ({ reason, path })),
        fixture.expected.diagnostics,
      );
      for (const diagnostic of result.diagnostics) {
        assert.equal(
          diagnostic.category,
          diagnosticReasons[diagnostic.reason].category,
        );
        assert.equal(
          diagnostic.severity,
          diagnosticReasons[diagnostic.reason].severity,
        );
        assert.notEqual(diagnostic.message, "");
      }
      assert.deepEqual(result.changes, []);
      assert.equal(result.normalizedDocument, undefined);
      assert.deepEqual(fixture.input, original);
    });
  }

  it("rejects non-object roots without throwing", () => {
    for (const value of [null, [], true, "Like"]) {
      const result = validateDocument(value);
      assert.equal(result.complete, true);
      assert.equal(result.diagnostics[0]?.reason, "invalid_document_root");
      assert.deepEqual(result.diagnostics[0]?.path, []);
    }
  });

  it("keeps optional fields optional and supports null as absence", () => {
    assert.deepEqual(
      validateDocument({ "@context": context, type: "Like", object: null }),
      {
        complete: true,
        diagnostics: [],
        changes: [],
      },
    );
  });

  it("distinguishes non-JSON roots from malformed document roots", () => {
    for (const value of [undefined, NaN, Infinity, 1n, Symbol("value")]) {
      const result = validateDocument(value);
      assert.equal(result.complete, true);
      assert.equal(result.diagnostics[0]?.reason, "non_json_value");
      assert.deepEqual(result.diagnostics[0]?.path, []);
    }
  });

  it("reports independent shape errors in source-key order", () => {
    const result = validateDocument({ ...like, object: 123, actor: false });
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "invalid_value_shape", path: ["actor"] },
        { reason: "invalid_value_shape", path: ["object"] },
      ],
    );
    assert.equal(result.complete, true);
  });

  it("does not claim coverage of unimplemented fields or nested values", () => {
    for (const input of [
      { ...like, published: "2026-10-26T00:00:00Z" },
      { ...like, object: { type: "Note", content: "Hello" } },
      { ...like, object: [like.object] },
      { ...like, type: "Create" },
      { ...like, type: ["Like", "https://example.com/CustomLike"] },
    ]) {
      const original = structuredClone(input);
      const result = validateDocument(input);
      assert.equal(result.complete, false);
      assert.ok(
        result.diagnostics.some(({ category }) => category === "support"),
      );
      assert.deepEqual(input, original);
    }
  });

  it("blocks an unavailable context without fetching or guessing property meanings", (test) => {
    const fetch = test.mock.method(globalThis, "fetch", () => {
      throw new Error("Unexpected network access");
    });
    const result = validateDocument({
      ...like,
      "@context": "https://remote.example/context",
      object: 123,
    });
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [{ reason: "context_unavailable_offline", path: ["@context"] }],
    );
  });

  it("reports an implicit context as a warning rather than rejection", () => {
    const result = validateDocument({ type: "Like", object: like.object });
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, severity }) => ({ reason, severity })),
      [{ reason: "implicit_activitystreams_context", severity: "warning" }],
    );
  });

  it("does not evaluate getters in a non-JSON input", () => {
    let evaluated = false;
    const input = {
      ...like,
      get object() {
        evaluated = true;
        throw new Error("Do not invoke input accessors");
      },
    };
    const result = validateDocument(input);
    assert.equal(evaluated, false);
    assert.equal(result.diagnostics[0]?.reason, "non_json_value");
    assert.deepEqual(result.diagnostics[0]?.path, ["object"]);
  });

  it("keeps relative references separate from malformed references", () => {
    const relative = validateDocument({ ...like, object: "/posts/42" });
    assert.equal(relative.complete, false);
    assert.equal(relative.diagnostics[0]?.reason, "unsupported_value_form");
    const malformed = validateDocument({
      ...like,
      object: "https://example.com/not valid",
    });
    assert.equal(malformed.complete, true);
    assert.equal(malformed.diagnostics[0]?.reason, "invalid_iri");
  });

  it("limits findings without claiming the remaining checks completed", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 150 }, (_, index) => [`extra${index}`, index]),
    );
    const result = validateDocument({ ...like, ...properties });
    assert.equal(result.complete, false);
    assert.equal(result.diagnostics.length, 100);
    assert.equal(result.diagnostics.at(-1)?.reason, "diagnostic_limit_reached");
    const exact = validateDocument({
      ...like,
      ...Object.fromEntries(Object.entries(properties).slice(0, 99)),
    });
    assert.equal(exact.diagnostics.length, 99);
    assert.ok(
      exact.diagnostics.every(
        ({ reason }) => reason !== "diagnostic_limit_reached",
      ),
    );
  });
});
