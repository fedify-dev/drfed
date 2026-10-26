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
import { Object as APObject, getEntityTypeById } from "@fedify/vocab";

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

describe("validateDocument() supported document checks", () => {
  for (const id of [
    "root-number",
    "like-reference",
    "like-number",
    "like-list-number",
    "like-multiple-actors",
    "create-note",
    "create-empty-content",
    "create-invalid-content",
    "create-reference",
    "undo-like",
    "undo-nested-number",
    "accept-follow-list",
    "accept-follow-list-actor",
    "accept-note",
    "like-target-reference",
    "like-origin-number",
    "create-result-note",
    "undo-instrument-list-number",
    "activity-reference",
    "activity-object-number",
    "intransitive-no-object",
    "intransitive-null-object",
    "intransitive-with-object",
    "arrive-no-object",
    "arrive-with-object",
    "arrive-null-object",
    "arrive-location-number",
  ]) {
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
      { ...like, object: { type: "Article", content: "Hello" } },
      { ...like, type: "Update" },
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

  it("preserves reference order and duplicates without fetching list entries", (test) => {
    const fetch = test.mock.method(globalThis, "fetch", () => {
      throw new Error("Unexpected network access");
    });
    const input = Object.freeze({
      ...like,
      actor: Object.freeze([like.actor, "https://example.com/bob", like.actor]),
      object: Object.freeze([
        like.object,
        "https://example.com/posts/43",
        like.object,
      ]),
    });
    const original = structuredClone(input);
    assert.deepEqual(validateDocument(input), {
      complete: true,
      diagnostics: [],
      changes: [],
    });
    assert.deepEqual(input, original);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("reports independent actor and object list failures at their original indexes", () => {
    const result = validateDocument({
      ...like,
      actor: [like.actor, false],
      object: [123, like.object, "https://example.com/not valid"],
    });
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "invalid_value_shape", path: ["actor", 1] },
        { reason: "invalid_value_shape", path: ["object", 0] },
        { reason: "invalid_iri", path: ["object", 2] },
      ],
    );
  });

  it("checks reference siblings while reporting unimplemented list entries", () => {
    const result = validateDocument({
      ...like,
      object: [like.object, { type: "Article", content: "Hello" }, 123],
    });
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "unsupported_type", path: ["object", 1, "type"] },
        { reason: "invalid_value_shape", path: ["object", 2] },
      ],
    );
  });

  it("checks embedded Notes at original list paths and preserves all input", (test) => {
    const fetch = test.mock.method(globalThis, "fetch", () => {
      throw new Error("Unexpected network access");
    });
    const input = Object.freeze({
      ...like,
      type: "Create",
      object: Object.freeze([
        like.object,
        Object.freeze({
          type: `${context}#Note`,
          id: like.object,
          attributedTo: Object.freeze([like.actor, false]),
          content: 123,
        }),
        Object.freeze({ type: "Note", content: "" }),
        like.object,
      ]),
    });
    const original = structuredClone(input);
    const result = validateDocument(input);
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        {
          reason: "invalid_value_shape",
          path: ["object", 1, "attributedTo", 1],
        },
        { reason: "invalid_value_shape", path: ["object", 1, "content"] },
      ],
    );
    assert.deepEqual(input, original);
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(result.changes, []);
    assert.equal(result.normalizedDocument, undefined);
  });

  it("supports standalone Notes and optional or empty content", () => {
    for (const content of [undefined, null, "", "<p>Hello</p>"]) {
      const result = validateDocument({
        "@context": context,
        type: "Note",
        ...(content === undefined ? {} : { content }),
      });
      assert.deepEqual(result, {
        complete: true,
        diagnostics: [],
        changes: [],
      });
    }
    assert.equal(
      validateDocument({ ...like, object: { type: "Note" } }).complete,
      true,
    );
    assert.equal(
      validateDocument({ ...like, type: `${context}#Create` }).complete,
      true,
    );
  });

  it("blocks an unknown nested context but still checks sibling objects", () => {
    const result = validateDocument({
      ...like,
      type: "Create",
      object: [
        {
          "@context": "https://remote.example/context",
          type: "Note",
          content: 123,
        },
        { type: "Note", content: false },
      ],
    });
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        {
          reason: "context_unavailable_offline",
          path: ["object", 0, "@context"],
        },
        { reason: "invalid_value_shape", path: ["object", 1, "content"] },
      ],
    );
  });

  it("does not mistake language forms or unimplemented Note fields for malformed data", () => {
    for (const content of [["Hello"], { en: "Hello" }]) {
      const result = validateDocument({
        ...like,
        object: { type: "Note", content },
      });
      assert.equal(result.complete, false);
      assert.equal(result.diagnostics[0]?.reason, "unsupported_value_form");
      assert.deepEqual(result.diagnostics[0]?.path, ["object", "content"]);
    }
    const result = validateDocument({
      ...like,
      object: { type: "Note", name: "Hello" },
    });
    assert.equal(result.complete, false);
    assert.equal(result.diagnostics[0]?.reason, "unsupported_property");
    assert.deepEqual(result.diagnostics[0]?.path, ["object", "name"]);
  });

  it("does not invoke embedded object getters", () => {
    let evaluated = false;
    const result = validateDocument({
      ...like,
      object: {
        type: "Note",
        get content() {
          evaluated = true;
          throw new Error("Do not invoke input accessors");
        },
      },
    });
    assert.equal(evaluated, false);
    assert.equal(result.diagnostics[0]?.reason, "non_json_value");
    assert.deepEqual(result.diagnostics[0]?.path, ["object", "content"]);
  });

  it("shares the diagnostic cap across embedded Notes", () => {
    const result = validateDocument({
      ...like,
      object: Array.from({ length: 110 }, () => ({
        type: "Note",
        content: 123,
      })),
    });
    assert.equal(result.complete, false);
    assert.equal(result.diagnostics.length, 100);
    assert.equal(result.diagnostics.at(-1)?.reason, "diagnostic_limit_reached");
    assert.deepEqual(result.diagnostics[0]?.path, ["object", 0, "content"]);
  });

  it("checks nested activities depth first, preserving list and property paths", () => {
    const input = {
      "@context": context,
      type: `${context}#Accept`,
      actor: false,
      object: [
        {
          type: "Undo",
          actor: like.actor,
          object: { type: `${context}#Like`, object: 123 },
          published: "2026-10-26T00:00:00Z",
        },
        456,
        { type: `${context}#Follow`, actor: false, object: like.actor },
      ],
      published: "2026-10-26T00:00:00Z",
    };
    const original = structuredClone(input);
    const expected = [
      { reason: "invalid_value_shape", path: ["actor"] },
      {
        reason: "invalid_value_shape",
        path: ["object", 0, "object", "object"],
      },
      { reason: "unsupported_property", path: ["object", 0, "published"] },
      { reason: "invalid_value_shape", path: ["object", 1] },
      { reason: "invalid_value_shape", path: ["object", 2, "actor"] },
      { reason: "unsupported_property", path: ["published"] },
    ];
    for (let index = 0; index < 2; index += 1) {
      const result = validateDocument(input);
      assert.equal(result.complete, false);
      assert.deepEqual(
        result.diagnostics.map(({ reason, path }) => ({ reason, path })),
        expected,
      );
    }
    assert.deepEqual(input, original);
  });

  it("keeps nested activity references offline without requiring embedded objects", (test) => {
    const fetch = test.mock.method(globalThis, "fetch", () => {
      throw new Error("Unexpected network access");
    });
    for (const type of ["Undo", "Accept", "Follow"]) {
      assert.deepEqual(validateDocument({ ...like, type }), {
        complete: true,
        diagnostics: [],
        changes: [],
      });
    }
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("blocks a nested activity context without skipping later siblings", () => {
    const result = validateDocument({
      ...like,
      type: "Undo",
      object: [
        {
          "@context": "https://remote.example/context",
          type: "Like",
          object: 123,
        },
        { type: "Follow", actor: false },
      ],
    });
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        {
          reason: "context_unavailable_offline",
          path: ["object", 0, "@context"],
        },
        { reason: "invalid_value_shape", path: ["object", 1, "actor"] },
      ],
    );
  });

  it("reports cycles without rejecting shared objects in separate branches", () => {
    const cyclic: Record<string, unknown> = {
      "@context": context,
      type: "Undo",
    };
    cyclic.object = cyclic;
    const cycle = validateDocument(cyclic);
    assert.equal(cycle.complete, true);
    assert.deepEqual(
      cycle.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [{ reason: "non_json_value", path: ["object"] }],
    );
    const shared = Object.freeze({ type: "Follow", actor: false });
    const result = validateDocument({
      ...like,
      type: "Accept",
      object: [shared, shared],
    });
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "invalid_value_shape", path: ["object", 0, "actor"] },
        { reason: "invalid_value_shape", path: ["object", 1, "actor"] },
      ],
    );
  });

  it("handles deep activity nesting without recursive calls or a new depth limit", () => {
    const depth = 3000;
    let input: unknown = { type: "Like", object: 123 };
    for (let index = 0; index < depth; index += 1) {
      input = { type: "Undo", object: input };
    }
    const result = validateDocument(input);
    assert.equal(result.complete, true);
    const failure = result.diagnostics.find(
      ({ reason }) => reason === "invalid_value_shape",
    );
    assert.ok(failure);
    assert.deepEqual(failure.path, Array(depth + 1).fill("object"));
  });

  it("keeps sparse and accessor entry findings in nested source order", () => {
    let evaluated = false;
    const object = [{ type: "Like", object: false }, undefined];
    Object.defineProperty(object, "1", {
      enumerable: true,
      get() {
        evaluated = true;
        throw new Error("Do not invoke accessors");
      },
    });
    object.length = 3;
    const result = validateDocument({ ...like, type: "Undo", object });
    assert.equal(evaluated, false);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "invalid_value_shape", path: ["object", 0, "object"] },
        { reason: "non_json_value", path: ["object", 1] },
        { reason: "non_json_value", path: ["object", 2] },
      ],
    );
  });

  it("recognizes base and intransitive types in short and full IRI forms without requiring fields", () => {
    for (const type of ["Activity", "IntransitiveActivity", "Arrive"]) {
      for (const spelling of [type, `${context}#${type}`]) {
        assert.deepEqual(
          validateDocument({ "@context": context, type: spelling }),
          {
            complete: true,
            diagnostics: [],
            changes: [],
          },
        );
      }
    }
  });

  it("does not admit types recognized by Fedify until their checker rules are implemented", () => {
    for (const type of ["Person", "Collection", "Update", "Question"]) {
      assert.ok(
        getEntityTypeById(`${context}#${type}`),
        `Fedify must recognize ${type}`,
      );
      for (const spelling of [type, `${context}#${type}`]) {
        const result = validateDocument({
          "@context": context,
          type: spelling,
        });
        assert.equal(result.complete, false);
        assert.deepEqual(
          result.diagnostics.map(({ reason, path }) => ({ reason, path })),
          [{ reason: "unsupported_type", path: ["type"] }],
        );
      }
    }
  });

  it("looks up implemented types without invoking the Fedify document parser or network", (test) => {
    const parser = test.mock.method(APObject, "fromJsonLd", () => {
      throw new Error("Type detection must not parse documents");
    });
    const fetch = test.mock.method(globalThis, "fetch", () => {
      throw new Error("Unexpected network access");
    });
    for (const type of [
      "Note",
      "Activity",
      "Like",
      "Create",
      "Undo",
      "Accept",
      "Follow",
      "IntransitiveActivity",
      "Arrive",
    ]) {
      for (const spelling of [type, `${context}#${type}`]) {
        assert.deepEqual(
          validateDocument({ "@context": context, type: spelling }),
          {
            complete: true,
            diagnostics: [],
            changes: [],
          },
        );
      }
    }
    assert.equal(parser.mock.callCount(), 0);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("keeps unknown and foreign type IRIs unsupported instead of guessing from their local names", () => {
    for (const type of [
      "CustomLike",
      `${context}#CustomLike`,
      "https://example.com/Like",
    ]) {
      assert.equal(
        getEntityTypeById(type.includes(":") ? type : `${context}#${type}`),
        undefined,
      );
      const result = validateDocument({ "@context": context, type });
      assert.equal(result.complete, false);
      assert.deepEqual(
        result.diagnostics.map(({ reason, path }) => ({ reason, path })),
        [{ reason: "unsupported_type", path: ["type"] }],
      );
    }
  });

  it("reports a non-null intransitive object as inapplicable regardless of its shape", () => {
    for (const type of ["IntransitiveActivity", "Arrive"]) {
      for (const object of [
        false,
        123,
        like.object,
        [],
        [like.object],
        { type: "Note", content: false },
      ]) {
        const result = validateDocument({ "@context": context, type, object });
        assert.equal(result.complete, true);
        assert.deepEqual(
          result.diagnostics.map(({ reason, path }) => ({ reason, path })),
          [{ reason: "property_not_applicable", path: ["object"] }],
        );
      }
    }
  });

  it("checks nested intransitive activities while continuing independent fields and siblings", () => {
    const input = {
      ...like,
      type: "Activity",
      object: [
        {
          type: `${context}#Arrive`,
          actor: false,
          location: [like.object, 123],
          object: { type: "Note", content: false },
          origin: false,
        },
        {
          type: `${context}#IntransitiveActivity`,
          object: null,
          result: { type: "Activity", object: 123 },
        },
        { type: "Activity", object: like.object },
      ],
    };
    const original = structuredClone(input);
    const result = validateDocument(input);
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "invalid_value_shape", path: ["object", 0, "actor"] },
        { reason: "invalid_value_shape", path: ["object", 0, "location", 1] },
        { reason: "property_not_applicable", path: ["object", 0, "object"] },
        { reason: "invalid_value_shape", path: ["object", 0, "origin"] },
        {
          reason: "invalid_value_shape",
          path: ["object", 1, "result", "object"],
        },
      ],
    );
    assert.deepEqual(input, original);
  });

  it("shares activity relations with the newly supported types and keeps location optional", (test) => {
    const fetch = test.mock.method(globalThis, "fetch", () => {
      throw new Error("Unexpected network access");
    });
    for (const type of ["Activity", "IntransitiveActivity", "Arrive"]) {
      const input = Object.freeze({
        "@context": context,
        type,
        actor: like.actor,
        target: Object.freeze([
          like.object,
          Object.freeze({ type: "Note", content: "Hello" }),
        ]),
        origin: like.object,
        result: Object.freeze({ type: "Activity", object: like.object }),
        instrument: like.object,
        location: Object.freeze([
          like.object,
          Object.freeze({ type: "Note", content: "Place" }),
          like.object,
        ]),
      });
      const original = structuredClone(input);
      assert.deepEqual(validateDocument(input), {
        complete: true,
        diagnostics: [],
        changes: [],
      });
      assert.deepEqual(input, original);
    }
    for (const type of ["Note", "Like"]) {
      assert.deepEqual(
        validateDocument({ "@context": context, type, location: null }),
        { complete: true, diagnostics: [], changes: [] },
      );
    }
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("reports unsupported location types and inherited context overrides without guessing", () => {
    const result = validateDocument({
      ...like,
      type: "Arrive",
      object: null,
      location: [
        { type: "Place", name: "Work" },
        {
          "@context": "https://remote.example/context",
          type: "Note",
          content: 123,
        },
        false,
      ],
    });
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "unsupported_type", path: ["location", 0, "type"] },
        {
          reason: "context_unavailable_offline",
          path: ["location", 1, "@context"],
        },
        { reason: "invalid_value_shape", path: ["location", 2] },
      ],
    );
  });

  for (const property of ["target", "origin", "result", "instrument"]) {
    it(`accepts ${property} references and supported embedded values without fetching or changing them`, (test) => {
      const fetch = test.mock.method(globalThis, "fetch", () => {
        throw new Error("Unexpected network access");
      });
      const note = Object.freeze({ type: "Note", content: "Hello" });
      const activity = Object.freeze({ type: "Follow", object: like.actor });
      for (const type of ["Like", "Create", "Undo", "Accept", "Follow"]) {
        for (const value of [
          null,
          like.object,
          note,
          activity,
          Object.freeze([like.object, note, activity, like.object]),
        ]) {
          const input = Object.freeze({ ...like, type, [property]: value });
          const original = structuredClone(input);
          assert.deepEqual(validateDocument(input), {
            complete: true,
            diagnostics: [],
            changes: [],
          });
          assert.deepEqual(input, original);
        }
      }
      assert.equal(fetch.mock.callCount(), 0);
    });

    it(`checks ${property} list entries and nested properties in source order`, () => {
      const result = validateDocument({
        ...like,
        [property]: [
          123,
          { type: "Note", content: false },
          { type: "Undo", [property]: { type: "Like", object: false } },
          "https://example.com/not valid",
          { type: "Article" },
          false,
        ],
      });
      assert.equal(result.complete, false);
      assert.deepEqual(
        result.diagnostics.map(({ reason, path }) => ({ reason, path })),
        [
          { reason: "invalid_value_shape", path: [property, 0] },
          { reason: "invalid_value_shape", path: [property, 1, "content"] },
          {
            reason: "invalid_value_shape",
            path: [property, 2, property, "object"],
          },
          { reason: "invalid_iri", path: [property, 3] },
          { reason: "unsupported_type", path: [property, 4, "type"] },
          { reason: "invalid_value_shape", path: [property, 5] },
        ],
      );
    });
  }

  it("keeps undecided relation forms unsupported and restricts the new properties to activities", () => {
    for (const property of ["target", "origin", "result", "instrument"]) {
      for (const [value, expectedPath] of [
        [[], [property]],
        [[null], [property, 0]],
        [[[like.object]], [property, 0]],
        ["/relative", [property]],
      ] as const) {
        const result = validateDocument({ ...like, [property]: value });
        assert.equal(result.complete, false);
        assert.deepEqual(
          result.diagnostics.map(({ reason, path }) => ({ reason, path })),
          [{ reason: "unsupported_value_form", path: expectedPath }],
        );
      }
      const note = validateDocument({
        "@context": context,
        type: "Note",
        [property]: like.object,
      });
      assert.equal(note.complete, false);
      assert.deepEqual(
        note.diagnostics.map(({ reason, path }) => ({ reason, path })),
        [{ reason: "unsupported_property", path: [property] }],
      );
    }
  });

  it("applies nested context blocking and cycle detection to the new relations", () => {
    const input: Record<string, unknown> = {
      ...like,
      instrument: {
        "@context": "https://remote.example/context",
        type: "Note",
        content: 123,
      },
      origin: false,
      result: { type: "Note", content: 123 },
    };
    input.target = input;
    const result = validateDocument(input);
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        {
          reason: "context_unavailable_offline",
          path: ["instrument", "@context"],
        },
        { reason: "invalid_value_shape", path: ["origin"] },
        { reason: "invalid_value_shape", path: ["result", "content"] },
        { reason: "non_json_value", path: ["target"] },
      ],
    );
  });

  it("keeps undecided empty lists, null entries, and nested lists incomplete", () => {
    for (const [object, path] of [
      [[], ["object"]],
      [[null], ["object", 0]],
      [[[like.object]], ["object", 0]],
    ] as const) {
      const result = validateDocument({ ...like, object });
      assert.equal(result.complete, false);
      assert.equal(result.diagnostics[0]?.reason, "unsupported_value_form");
      assert.deepEqual(result.diagnostics[0]?.path, path);
    }
  });

  it("does not evaluate list accessors or silently skip sparse entries", () => {
    let evaluated = false;
    const accessor = [like.object];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        evaluated = true;
        throw new Error("Do not invoke input accessors");
      },
    });
    const sparse = [like.object];
    sparse.length = 2;
    for (const [object, index] of [
      [accessor, 0],
      [sparse, 1],
    ] as const) {
      const result = validateDocument({ ...like, object });
      assert.equal(result.diagnostics[0]?.reason, "non_json_value");
      assert.deepEqual(result.diagnostics[0]?.path, ["object", index]);
    }
    assert.equal(evaluated, false);
  });

  it("does not impose the deferred value-count budget on reference lists", () => {
    const result = validateDocument({
      ...like,
      actor: Array(6000).fill(like.actor),
      object: Array(6000).fill(like.object),
    });
    assert.deepEqual(result, { complete: true, diagnostics: [], changes: [] });
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
