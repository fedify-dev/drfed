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
import {
  Object as APObject,
  Link,
  Mention,
  getEntityTypeById,
} from "@fedify/vocab";
import { preloadedContexts } from "@fedify/vocab-runtime";
import jsonld from "@fedify/vocab-runtime/jsonld";

interface DraftFixture {
  readonly id: string;
  readonly input: unknown;
  readonly expected: {
    readonly complete: boolean;
    readonly diagnostics: readonly {
      readonly reason: DiagnosticReason;
      readonly path: FieldPath;
    }[];
    readonly changes?: readonly {
      readonly reason: string;
      readonly operation: string;
      readonly path: FieldPath;
      readonly before: unknown;
    }[];
    readonly normalizedDocument?: unknown;
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
  it("recognizes public Link classes separately from the entity registry", () => {
    for (const Type of [Link, Mention]) {
      assert.equal(getEntityTypeById(Type.typeId.href), undefined);
      for (const type of [Type.name, Type.typeId.href]) {
        const result = validateDocument({
          "@context": context,
          type,
          href: "https://example.com/",
        });
        assert.equal(result.complete, true);
        assert.deepEqual(result.diagnostics, []);
      }
    }
  });

  it("keeps Link metadata unchanged and never fetches its target", (t) => {
    const fetch = t.mock.method(globalThis, "fetch", () => {
      throw new Error("Unexpected network access");
    });
    const input = Object.freeze({
      "@context": context,
      type: "Link",
      href: "https://example.com/",
      rel: Object.freeze(["alternate", "alternate"]),
      mediaType: "Text/HTML",
      hreflang: "EN-us",
    });
    const original = structuredClone(input);
    const result = validateDocument(input);
    assert.equal(result.complete, true);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(input, original);
    assert.deepEqual(result.changes, []);
    assert.equal(result.normalizedDocument, undefined);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("detects preview cycles while allowing repeated Link values in separate branches", () => {
    const link: Record<string, unknown> = {
      type: "Link",
      href: "https://example.com/",
    };
    link.preview = link;
    const result = validateDocument({ ...like, object: [link, link] });
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "non_json_value", path: ["object", 0, "preview"] },
        { reason: "non_json_value", path: ["object", 1, "preview"] },
      ],
    );
  });

  for (const fixture of fixtures) {
    it(`matches the ${fixture.id} draft fixture`, () => {
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
      assert.deepEqual(
        result.changes.map(({ reason, operation, path, ...change }) => ({
          reason,
          operation,
          path,
          before: "before" in change ? change.before : undefined,
        })),
        fixture.expected.changes ?? [],
      );
      assert.deepEqual(
        result.normalizedDocument,
        fixture.expected.normalizedDocument,
      );
      assert.deepEqual(fixture.input, original);
    });
  }

  it("checks aliased nested values at original indexes without expanding away nulls", () => {
    const input = {
      "@context": [
        context,
        { payload: { "@id": `${context}#object`, "@type": "@id" } },
      ],
      type: "Undo",
      payload: [null, like.object, 123, { type: "Like", payload: false }],
    };
    const original = structuredClone(input);
    const result = validateDocument(input);
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "invalid_value_shape", path: ["payload", 2] },
        { reason: "invalid_value_shape", path: ["payload", 3, "payload"] },
      ],
    );
    assert.deepEqual(input, original);
  });

  it("resolves type/id aliases, prefixes, full IRIs, and language containers", () => {
    const input = {
      "@context": [
        context,
        {
          v: { "@id": `${context}#`, "@prefix": true },
          kind: "@type",
          identifier: "@id",
          title: "v:name",
          titles: { "@id": "v:name", "@container": "@language" },
        },
      ],
      kind: "v:Note",
      identifier: like.object,
      title: "Title",
      titles: { en: "Title", ko: "제목" },
      [`${context}#summary`]: "<p>Summary</p>",
      "v:content": "<p>Content</p>",
    };
    assert.deepEqual(validateDocument(input), {
      complete: true,
      diagnostics: [],
      changes: [],
    });
    const invalid = validateDocument({
      ...input,
      identifier: 123,
      titles: { en: false },
    });
    assert.deepEqual(
      invalid.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "invalid_value_shape", path: ["identifier"] },
        { reason: "invalid_value_shape", path: ["titles", "en"] },
      ],
    );
  });

  it("isolates nested alias overrides from their siblings", () => {
    const input = {
      "@context": [
        context,
        { payload: { "@id": `${context}#object`, "@type": "@id" } },
      ],
      type: "Undo",
      payload: [
        {
          "@context": {
            payload: { "@id": `${context}#location`, "@type": "@id" },
          },
          type: "Arrive",
          payload: like.object,
        },
        { type: "Like", payload: false },
        { type: "Arrive", payload: like.object },
      ],
    };
    const original = structuredClone(input);
    const result = validateDocument(input);
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "invalid_value_shape", path: ["payload", 1, "payload"] },
        { reason: "property_not_applicable", path: ["payload", 2, "payload"] },
      ],
    );
    assert.deepEqual(input, original);
  });

  it("counts functional aliases together without merging their original values", () => {
    const input = {
      "@context": [
        context,
        { when: { "@id": `${context}#published`, "@type": "xsd:dateTime" } },
      ],
      type: "Note",
      published: "2026-10-27T12:00Z",
      when: [null, "not-a-date"],
    };
    const original = structuredClone(input);
    const result = validateDocument(input);
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "invalid_multiplicity", path: ["published"] },
        { reason: "invalid_multiplicity", path: ["when"] },
        { reason: "invalid_datetime", path: ["when", 1] },
      ],
    );
    const single = validateDocument({
      ...input,
      published: null,
      when: [null, "2026-10-27T12:00Z"],
    });
    assert.deepEqual(single, { complete: true, diagnostics: [], changes: [] });
    assert.deepEqual(input, original);
  });

  it("keeps mismatched term coercion unsupported instead of inheriting it by IRI", () => {
    for (const [key, inline] of [
      ["payload", { payload: "as:object" }],
      ["as:object", {}],
      [`${context}#object`, {}],
    ] as const) {
      const result = validateDocument({
        "@context": [context, inline],
        type: "Like",
        [key]: like.object,
      });
      assert.equal(result.complete, false);
      assert.deepEqual(
        result.diagnostics.map(({ reason, path }) => ({ reason, path })),
        [{ reason: "unsupported_value_form", path: [key] }],
      );
    }
  });

  it("keeps arbitrary custom properties unsupported and retains their raw data", () => {
    for (const inline of [
      {},
      { debugData: "https://example.com/ns#debugData" },
    ]) {
      const input = {
        "@context": [context, inline],
        type: "Note",
        debugData: { value: [null, 123], type: "custom" },
      };
      const original = structuredClone(input);
      const result = validateDocument(input);
      assert.equal(result.complete, false);
      assert.deepEqual(
        result.diagnostics.map(({ reason, path }) => ({ reason, path })),
        [{ reason: "unsupported_property", path: ["debugData"] }],
      );
      assert.deepEqual(input, original);
      assert.deepEqual(result.changes, []);
      assert.equal(result.normalizedDocument, undefined);
    }
    const known = validateDocument({
      "@context": context,
      type: "Note",
      duration: "not-a-duration",
    });
    assert.equal(known.complete, false);
    assert.equal(known.diagnostics[0]?.reason, "unsupported_property");
  });

  it("uses allowlisted bundled contexts without fetching context or resource URLs", (t) => {
    const fetch = t.mock.method(globalThis, "fetch", () => {
      throw new Error("Unexpected fetch");
    });
    for (const declaration of [
      context,
      [context],
      [context, "https://w3id.org/security/v1"],
    ]) {
      assert.deepEqual(validateDocument({ ...like, "@context": declaration }), {
        complete: true,
        diagnostics: [],
        changes: [],
      });
    }
    const blocked = validateDocument({
      ...like,
      "@context": [context, "https://remote.example/context"],
    });
    assert.equal(blocked.complete, false);
    assert.deepEqual(
      blocked.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [{ reason: "context_unavailable_offline", path: ["@context", 1] }],
    );
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("distinguishes malformed inline contexts from unsupported JSON-LD features", () => {
    for (const [inline, reason, suffix] of [
      [{ bad: { "@id": 123 } }, "invalid_context", "bad"],
      [{ bad: "@graph" }, "unsupported_context_form", "bad"],
      [{ "as:object": "as:target" }, "unsupported_context_form", "as:object"],
      [
        { bad: { "@id": "@id", "@type": "@id" } },
        "unsupported_context_form",
        "bad",
      ],
      [
        {
          bad: { "@id": "as:name", "@container": "@language", "@type": "@id" },
        },
        "unsupported_context_form",
        "bad",
      ],
      [
        { bad: { "@id": "as:object", "@context": {} } },
        "unsupported_context_form",
        "bad",
      ],
      [{ "@language": "en" }, "unsupported_context_form", "@language"],
      [
        { "@base": "https://example.com/" },
        "unsupported_context_form",
        "@base",
      ],
      [
        { bad: { "@id": "as:object", "@type": "@json" } },
        "unsupported_context_form",
        "bad",
      ],
      [
        { object: { "@id": "as:target", "@type": "@id" } },
        "unsupported_context_form",
        "object",
      ],
    ] as const) {
      const result = validateDocument({
        ...like,
        "@context": [context, inline],
      });
      assert.deepEqual(
        result.diagnostics.map(({ reason: actual, path }) => ({
          reason: actual,
          path,
        })),
        [{ reason, path: ["@context", 1, suffix] }],
      );
    }
    const cyclic = validateDocument({
      ...like,
      "@context": [context, { a: "b", b: "a" }],
    });
    assert.ok(
      cyclic.diagnostics.every(({ reason }) => reason === "invalid_context"),
    );
    assert.deepEqual(
      cyclic.diagnostics.map(({ path }) => path),
      [
        ["@context", 1, "a"],
        ["@context", 1, "b"],
      ],
    );
  });

  it("never invokes context or term-definition accessors", () => {
    let evaluated = false;
    const definition = Object.defineProperty({}, "@id", {
      enumerable: true,
      get() {
        evaluated = true;
        throw new Error("Unexpected getter");
      },
    });
    const result = validateDocument({
      ...like,
      "@context": [context, { payload: definition }],
    });
    assert.equal(evaluated, false);
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [{ reason: "non_json_value", path: ["@context", 1, "payload", "@id"] }],
    );
  });

  it("uses original addressing aliases in normalized previews and change paths", () => {
    const input = {
      "@context": [
        context,
        {
          recipients: { "@id": "as:to", "@type": "@id" },
          payload: { "@id": "as:object", "@type": "@id" },
        },
      ],
      type: "Create",
      recipients: [],
      payload: { type: "Note", recipients: [] },
    };
    const original = structuredClone(input);
    const result = validateDocument(input);
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ path }) => path),
      [["payload", "recipients"], ["recipients"]],
    );
    assert.deepEqual(
      result.changes.map(({ path }) => path),
      [["payload", "recipients"], ["recipients"]],
    );
    assert.deepEqual(result.normalizedDocument, {
      "@context": input["@context"],
      type: "Create",
      payload: { type: "Note" },
    });
    assert.deepEqual(input, original);
  });

  it("matches Fedify expansion for the admitted forward-prefix profile while retaining source paths", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", () => {
      throw new Error("Unexpected fetch");
    });
    const bundled = structuredClone(preloadedContexts[context]);
    const input = {
      "@context": [
        context,
        { payload: { "@id": "z:object", "@type": "@id" }, z: `${context}#` },
      ],
      type: "z:Like",
      payload: [null, 123, { type: "Like", payload: false }],
    };
    const original = structuredClone(input);
    const expanded = await jsonld.expand(input, {
      documentLoader: (url: string) => {
        assert.equal(url, context);
        return Promise.resolve({
          contextUrl: null,
          documentUrl: url,
          document: structuredClone(preloadedContexts[context]),
        });
      },
    });
    assert.deepEqual(expanded, [
      {
        "@type": [`${context}#Like`],
        [`${context}#object`]: [
          { "@value": 123 },
          {
            "@type": [`${context}#Like`],
            [`${context}#object`]: [{ "@value": false }],
          },
        ],
      },
    ]);
    const result = validateDocument(input);
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "invalid_value_shape", path: ["payload", 1] },
        { reason: "invalid_value_shape", path: ["payload", 2, "payload"] },
      ],
    );
    assert.deepEqual(preloadedContexts[context], bundled);
    assert.deepEqual(input, original);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("checks all timestamp properties with ActivityStreams calendar and lexical rules", () => {
    for (const property of ["published", "updated", "startTime", "endTime"]) {
      for (const value of [
        "2024-02-29T12:34Z",
        "2026-10-27T12:34:56.123456789123+05:30",
        null,
        [null],
      ]) {
        assert.deepEqual(
          validateDocument({
            "@context": context,
            type: "Note",
            [property]: value,
          }),
          { complete: true, diagnostics: [], changes: [] },
        );
      }
      for (const value of [
        "2023-02-29T12:34Z",
        "2024-02-30T12:34Z",
        "2026-13-01T12:34Z",
        "2026-01-01T24:00Z",
        "2026-01-01T12:60Z",
        "2026-01-01T12:34+24:00",
        "2026-01-01t12:34Z",
        "2026-01-01T12:34z",
        "2026-01-01T12:34",
        "2026-01-01",
      ]) {
        const result = validateDocument({
          "@context": context,
          type: "Note",
          [property]: [null, value],
        });
        assert.equal(result.complete, true);
        assert.deepEqual(
          result.diagnostics.map(({ reason, path }) => ({ reason, path })),
          [{ reason: "invalid_datetime", path: [property, 1] }],
        );
      }
    }
    const leap = validateDocument({
      "@context": context,
      type: "Note",
      published: "2016-12-31T23:59:60Z",
    });
    assert.equal(leap.complete, false);
    assert.equal(leap.diagnostics[0]?.reason, "unsupported_value_form");
  });

  it("checks functional values and preserves scalar, list, and null-entry paths", () => {
    for (const [type, property, value] of [
      ["Note", "id", like.object],
      ["Link", "href", like.object],
      ["Link", "width", 0],
      ["Link", "height", 1],
      ["Link", "mediaType", "text/html"],
      ["Link", "hreflang", "en"],
      ["Collection", "totalItems", 2],
      ["OrderedCollectionPage", "startIndex", 0],
      ["CollectionPage", "next", { type: "CollectionPage" }],
      ["Person", "inbox", { type: "OrderedCollection" }],
    ] as const) {
      const input = { "@context": context, type, [property]: [null, value] };
      const original = structuredClone(input);
      assert.deepEqual(validateDocument(input), {
        complete: true,
        diagnostics: [],
        changes: [],
      });
      assert.deepEqual(input, original);
      const repeated = validateDocument({
        ...input,
        [property]: [value, null, value],
      });
      assert.equal(repeated.complete, true);
      assert.deepEqual(
        repeated.diagnostics.map(({ reason, path }) => ({ reason, path })),
        [{ reason: "invalid_multiplicity", path: [property] }],
      );
    }
  });

  it("checks actor usernames without adding actor requirements or applying them to other types", () => {
    for (const type of [
      "Application",
      "Group",
      "Organization",
      "Person",
      "Service",
    ]) {
      assert.deepEqual(
        validateDocument({
          "@context": context,
          type,
          preferredUsername: [null, "alice"],
        }),
        { complete: true, diagnostics: [], changes: [] },
      );
      const result = validateDocument({
        ...like,
        actor: { type, preferredUsername: false },
      });
      assert.equal(result.complete, true);
      assert.deepEqual(
        result.diagnostics.map(({ reason, path }) => ({ reason, path })),
        [
          {
            reason: "invalid_value_shape",
            path: ["actor", "preferredUsername"],
          },
        ],
      );
    }
    for (const type of ["Note", "Link"]) {
      const result = validateDocument({
        "@context": context,
        type,
        preferredUsername: "alice",
      });
      assert.equal(result.complete, false);
      assert.equal(result.diagnostics[0]?.reason, "unsupported_property");
    }
  });

  it("reports text-value attributes and language-map accessors without invoking them", () => {
    let evaluated = false;
    const map = Object.defineProperty({}, "en", {
      enumerable: true,
      get() {
        evaluated = true;
        throw new Error("Unexpected getter");
      },
    });
    const result = validateDocument({
      ...like,
      object: {
        type: "Note",
        contentMap: map,
        name: [null, { "@value": 123, "@language": false }],
        summary: [{ "@value": "Text", "@direction": "rtl" }],
      },
    });
    assert.equal(evaluated, false);
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "non_json_value", path: ["object", "contentMap", "en"] },
        {
          reason: "invalid_value_shape",
          path: ["object", "name", 1, "@language"],
        },
        {
          reason: "invalid_value_shape",
          path: ["object", "name", 1, "@value"],
        },
        {
          reason: "unsupported_value_form",
          path: ["object", "summary", 0, "@direction"],
        },
      ],
    );
  });

  it("preserves addressing values and proposes nested empty-list omission in an independent preview", (t) => {
    const fetch = t.mock.method(globalThis, "fetch", () => {
      throw new Error("Unexpected network access");
    });
    const recipients = Object.freeze([null, like.actor, like.actor]);
    const object = Object.freeze({
      type: "Note",
      to: Object.freeze([]),
      cc: recipients,
    });
    const input = Object.freeze({
      ...like,
      bcc: Object.freeze([]),
      object: Object.freeze([object]),
    });
    const original = structuredClone(input);
    const result = validateDocument(input);
    assert.equal(result.complete, true);
    assert.ok(
      result.diagnostics.every(({ severity }) => severity === "warning"),
    );
    assert.deepEqual(
      result.changes.map(({ reason, operation, path }) => ({
        reason,
        operation,
        path,
      })),
      [
        {
          reason: "omit_empty_addressing_list",
          operation: "remove",
          path: ["bcc"],
        },
        {
          reason: "omit_empty_addressing_list",
          operation: "remove",
          path: ["object", 0, "to"],
        },
      ],
    );
    assert.deepEqual(result.normalizedDocument, {
      ...like,
      object: [{ type: "Note", cc: [null, like.actor, like.actor] }],
    });
    assert.deepEqual(input, original);
    const previewObject = (
      result.normalizedDocument!.object as { cc: unknown[] }[]
    )[0]!;
    previewObject.cc.push("https://example.com/bob");
    assert.deepEqual(input, original);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("withholds normalization when there are errors, unsupported fields, or truncated findings", () => {
    for (const fields of [
      { object: 123 },
      { extra: true },
      { actor: Array(110).fill(false) },
    ]) {
      const result = validateDocument({ ...like, to: [], ...fields });
      assert.equal(result.normalizedDocument, undefined);
      assert.deepEqual(result.changes, []);
    }
    for (const property of ["to", "cc", "bto", "bcc", "audience"]) {
      const result = validateDocument({
        "@context": context,
        type: "Link",
        [property]: [],
      });
      assert.equal(result.complete, false);
      assert.equal(result.diagnostics[0]?.reason, "unsupported_property");
    }
  });

  it("creates an empty-addressing preview for deep documents without recursive cloning", () => {
    let input: Record<string, unknown> = { type: "Note", to: [] };
    for (let index = 0; index < 3000; index += 1) {
      input = { type: "Create", object: input };
    }
    input["@context"] = context;
    const result = validateDocument(input);
    assert.equal(result.complete, true);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.changes[0]?.path.length, 3001);
    let preview = result.normalizedDocument!;
    for (let index = 0; index < 3000; index += 1) {
      preview = preview.object as typeof preview;
    }
    assert.deepEqual(preview, { type: "Note" });
  });

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
      { ...like, duration: "PT1H" },
      { ...like, object: { type: "Page", content: "Hello" } },
      { ...like, type: "Page" },
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
      object: [like.object, { type: "Page", content: "Hello" }, 123],
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

  it("requires the language-map property name for an untagged language object", () => {
    for (const content of [{ en: "Hello" }]) {
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
    assert.equal(result.complete, true);
    assert.deepEqual(result.diagnostics, []);
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
      { reason: "invalid_value_shape", path: ["object", 1] },
      { reason: "invalid_value_shape", path: ["object", 2, "actor"] },
    ];
    for (let index = 0; index < 2; index += 1) {
      const result = validateDocument(input);
      assert.equal(result.complete, true);
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
    for (const type of [
      "Activity",
      "IntransitiveActivity",
      "Arrive",
      "Travel",
      "Question",
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
  });

  it("does not admit types recognized by Fedify until their checker rules are implemented", () => {
    for (const type of ["Page", "Place", "Image", "Event"]) {
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

  it("applies shared activity rules to the new ordinary types in compact and full IRI forms", (test) => {
    const fetch = test.mock.method(globalThis, "fetch", () => {
      throw new Error("Unexpected network access");
    });
    for (const type of [
      "Add",
      "Announce",
      "Block",
      "Delete",
      "Dislike",
      "Flag",
      "Ignore",
      "Invite",
      "Join",
      "Leave",
      "Listen",
      "Move",
      "Offer",
      "Read",
      "Reject",
      "Remove",
      "TentativeAccept",
      "TentativeReject",
      "Update",
      "View",
    ]) {
      for (const spelling of [type, `${context}#${type}`]) {
        // Vocabulary properties remain optional, including actor and object.
        assert.deepEqual(
          validateDocument({ "@context": context, type: spelling }),
          {
            complete: true,
            diagnostics: [],
            changes: [],
          },
        );
        const input = {
          "@context": context,
          type: spelling,
          actor: false,
          instrument: 123,
          object: [{ type: "Note", content: false }],
          origin: [like.object, false],
          result: 123,
          target: false,
        };
        const original = structuredClone(input);
        const result = validateDocument(input);
        assert.equal(result.complete, true);
        assert.deepEqual(
          result.diagnostics.map(({ reason, path }) => ({ reason, path })),
          [
            { reason: "invalid_value_shape", path: ["actor"] },
            { reason: "invalid_value_shape", path: ["instrument"] },
            { reason: "invalid_value_shape", path: ["object", 0, "content"] },
            { reason: "invalid_value_shape", path: ["origin", 1] },
            { reason: "invalid_value_shape", path: ["result"] },
            { reason: "invalid_value_shape", path: ["target"] },
          ],
        );
        assert.deepEqual(input, original);
      }
    }
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("recognizes inherited activity families in nested new types without applying their social effects", () => {
    const input = {
      ...like,
      type: "TentativeAccept",
      object: [
        {
          type: "Invite",
          object: { type: "Block", actor: false, object: like.actor },
        },
        {
          type: "TentativeReject",
          object: { type: "Update", object: { type: "Note", content: 123 } },
        },
      ],
    };
    const original = structuredClone(input);
    const result = validateDocument(input);
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        {
          reason: "invalid_value_shape",
          path: ["object", 0, "object", "actor"],
        },
        {
          reason: "invalid_value_shape",
          path: ["object", 1, "object", "object", "content"],
        },
      ],
    );
    assert.deepEqual(input, original);
  });

  it("uses shared Object rules for Object and Article without activity properties", () => {
    for (const type of ["Object", "Article"]) {
      for (const spelling of [type, `${context}#${type}`]) {
        assert.deepEqual(
          validateDocument({ "@context": context, type: spelling }),
          {
            complete: true,
            diagnostics: [],
            changes: [],
          },
        );
        for (const content of [null, "", "<p>Text</p>"]) {
          assert.deepEqual(
            validateDocument({ "@context": context, type: spelling, content }),
            {
              complete: true,
              diagnostics: [],
              changes: [],
            },
          );
        }
        const result = validateDocument({
          "@context": context,
          type: spelling,
          actor: like.actor,
          content: false,
          object: like.object,
        });
        assert.equal(result.complete, false);
        assert.deepEqual(
          result.diagnostics.map(({ reason, path }) => ({ reason, path })),
          [
            { reason: "unsupported_property", path: ["actor"] },
            { reason: "invalid_value_shape", path: ["content"] },
            { reason: "unsupported_property", path: ["object"] },
          ],
        );
      }
    }
  });

  it("preserves Object and Article reference values and nested source paths without fetching", (test) => {
    const fetch = test.mock.method(globalThis, "fetch", () => {
      throw new Error("Unexpected network access");
    });
    for (const type of ["Object", "Article"]) {
      const embedded = Object.freeze({
        type: `${context}#${type}`,
        id: like.object,
        content: "",
        attributedTo: Object.freeze([like.actor, like.actor]),
        location: Object.freeze([
          like.object,
          Object.freeze({ type: "Object", content: "Place description" }),
        ]),
      });
      const input = Object.freeze({
        ...like,
        type: "Update",
        object: Object.freeze([like.object, embedded, like.object]),
      });
      const original = structuredClone(input);
      assert.deepEqual(validateDocument(input), {
        complete: true,
        diagnostics: [],
        changes: [],
      });
      assert.deepEqual(input, original);
    }
    const result = validateDocument({
      ...like,
      type: "Create",
      object: [
        { type: "Object", attributedTo: [like.actor, false] },
        { type: "Article", location: [{ type: "Object", content: 123 }] },
      ],
    });
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        {
          reason: "invalid_value_shape",
          path: ["object", 0, "attributedTo", 1],
        },
        {
          reason: "invalid_value_shape",
          path: ["object", 1, "location", 0, "content"],
        },
      ],
    );
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("checks the five actor types as Objects in root and embedded forms", (test) => {
    const fetch = test.mock.method(globalThis, "fetch", () => {
      throw new Error("Unexpected network access");
    });
    for (const type of [
      "Application",
      "Group",
      "Organization",
      "Person",
      "Service",
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
        const actor = Object.freeze({
          type: spelling,
          id: like.actor,
          content: "",
        });
        const input = Object.freeze({
          ...like,
          actor: Object.freeze([like.actor, actor, like.actor]),
          object: Object.freeze({
            type: "Article",
            attributedTo: actor,
            location: actor,
          }),
        });
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

  it("applies Object-or-Link shape rules without inventing an actor-only vocabulary restriction", () => {
    const result = validateDocument({
      ...like,
      actor: [
        { type: "Note", content: 123 },
        { type: "Person", id: false },
        false,
      ],
      object: {
        type: "Article",
        attributedTo: [
          { type: "Create", object: 123 },
          { type: "Group", content: false },
        ],
      },
    });
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "invalid_value_shape", path: ["actor", 0, "content"] },
        { reason: "invalid_value_shape", path: ["actor", 1, "id"] },
        { reason: "invalid_value_shape", path: ["actor", 2] },
        {
          reason: "invalid_value_shape",
          path: ["object", "attributedTo", 0, "object"],
        },
        {
          reason: "invalid_value_shape",
          path: ["object", "attributedTo", 1, "content"],
        },
      ],
    );
  });

  it("checks embedded Link values while keeping unimplemented actor fields explicit", () => {
    const result = validateDocument({
      ...like,
      actor: [
        { type: "Link", href: 123 },
        {
          type: "Person",
          publicKey: "https://example.com/key",
        },
      ],
    });
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "invalid_value_shape", path: ["actor", 0, "href"] },
        {
          reason: "unsupported_property",
          path: ["actor", 1, "publicKey"],
        },
      ],
    );
  });

  it("detects actor/attribution cycles without rejecting shared actors in separate branches", () => {
    const actor: Record<string, unknown> = { type: "Person", id: like.actor };
    actor.attributedTo = actor;
    const result = validateDocument({ ...like, actor: [actor, actor] });
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "non_json_value", path: ["actor", 0, "attributedTo"] },
        { reason: "non_json_value", path: ["actor", 1, "attributedTo"] },
      ],
    );
  });

  it("reports a non-null intransitive object as inapplicable regardless of its shape", () => {
    for (const type of [
      "IntransitiveActivity",
      "Arrive",
      "Travel",
      "Question",
    ]) {
      for (const object of [
        false,
        123,
        like.object,
        { type: "Note", content: false },
      ]) {
        const result = validateDocument({ "@context": context, type, object });
        assert.equal(result.complete, true);
        assert.deepEqual(
          result.diagnostics.map(({ reason, path }) => ({ reason, path })),
          [{ reason: "property_not_applicable", path: ["object"] }],
        );
      }
      assert.deepEqual(
        validateDocument({ "@context": context, type, object: [null] }),
        {
          complete: true,
          diagnostics: [],
          changes: [],
        },
      );
      const listed = validateDocument({
        "@context": context,
        type,
        object: [null, like.object],
      });
      assert.equal(listed.complete, true);
      assert.deepEqual(
        listed.diagnostics.map(({ reason, path }) => ({ reason, path })),
        [{ reason: "property_not_applicable", path: ["object", 1] }],
      );
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
    for (const type of [
      "Activity",
      "IntransitiveActivity",
      "Arrive",
      "Travel",
      "Question",
    ]) {
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

  it("checks standalone and nested Travel and Question through inherited rules", () => {
    const input = {
      ...like,
      type: "Create",
      object: [
        {
          type: `${context}#Travel`,
          actor: false,
          object: { type: "Note", content: false },
          origin: [like.object, 123],
          target: like.object,
        },
        {
          type: `${context}#Question`,
          object: false,
          result: { type: "Travel", object: 123 },
        },
      ],
    };
    const original = structuredClone(input);
    const result = validateDocument(input);
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "invalid_value_shape", path: ["object", 0, "actor"] },
        { reason: "property_not_applicable", path: ["object", 0, "object"] },
        { reason: "invalid_value_shape", path: ["object", 0, "origin", 1] },
        { reason: "property_not_applicable", path: ["object", 1, "object"] },
        {
          reason: "property_not_applicable",
          path: ["object", 1, "result", "object"],
        },
      ],
    );
    assert.deepEqual(input, original);
  });

  it("keeps new intransitive types offline and safely handles nested contexts and accessors", (test) => {
    const fetch = test.mock.method(globalThis, "fetch", () => {
      throw new Error("Unexpected network access");
    });
    let evaluated = false;
    const result = validateDocument({
      ...like,
      type: "Create",
      object: [
        {
          "@context": "https://remote.example/context",
          type: "Question",
          object: 123,
        },
        {
          type: "Travel",
          get target() {
            evaluated = true;
            throw new Error("Do not invoke accessors");
          },
        },
        { type: "Question", content: 123 },
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
        { reason: "non_json_value", path: ["object", 1, "target"] },
        { reason: "invalid_value_shape", path: ["object", 2, "content"] },
      ],
    );
    assert.equal(evaluated, false);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("checks collection variants and count fields without requiring members or matching visible length", () => {
    for (const type of [
      "Collection",
      "OrderedCollection",
      "CollectionPage",
      "OrderedCollectionPage",
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
        assert.deepEqual(
          validateDocument({
            "@context": context,
            type: spelling,
            totalItems: 100,
            items: like.object,
          }),
          {
            complete: true,
            diagnostics: [],
            changes: [],
          },
        );
        for (const totalItems of [-1, 1.5, "2", false]) {
          const result = validateDocument({
            "@context": context,
            type: spelling,
            totalItems,
          });
          assert.equal(result.complete, true);
          assert.deepEqual(
            result.diagnostics.map(({ reason, path }) => ({ reason, path })),
            [{ reason: "invalid_value_shape", path: ["totalItems"] }],
          );
        }
      }
    }
    assert.deepEqual(
      validateDocument({
        "@context": context,
        type: "OrderedCollectionPage",
        startIndex: null,
        totalItems: null,
      }),
      {
        complete: true,
        diagnostics: [],
        changes: [],
      },
    );
  });

  it("preserves nested collection member order and duplicates without fetching references", (test) => {
    const fetch = test.mock.method(globalThis, "fetch", () => {
      throw new Error("Unexpected network access");
    });
    const members = Object.freeze([
      like.object,
      Object.freeze({ type: "Article", content: "Text" }),
      like.object,
    ]);
    const target = Object.freeze({
      type: `${context}#OrderedCollection`,
      totalItems: 50,
      orderedItems: members,
    });
    const input = Object.freeze({ ...like, type: "Add", target });
    const original = structuredClone(input);
    assert.deepEqual(validateDocument(input), {
      complete: true,
      diagnostics: [],
      changes: [],
    });
    assert.deepEqual(input, original);
    const result = validateDocument({
      ...like,
      type: "Add",
      target: {
        type: "OrderedCollection",
        totalItems: -1,
        orderedItems: [
          like.object,
          { type: "CollectionPage", items: [{ type: "Note", content: 123 }] },
          false,
        ],
      },
    });
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        {
          reason: "invalid_value_shape",
          path: ["target", "orderedItems", 1, "items", 0, "content"],
        },
        { reason: "invalid_value_shape", path: ["target", "orderedItems", 2] },
        { reason: "invalid_value_shape", path: ["target", "totalItems"] },
      ],
    );
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("checks embedded navigation ranges and permits single-value arrays", () => {
    const result = validateDocument({
      "@context": context,
      type: "OrderedCollectionPage",
      current: { type: "OrderedCollectionPage", startIndex: -1 },
      first: { type: "CollectionPage", items: 123 },
      last: { type: "Collection" },
      next: ["https://example.com/page"],
      partOf: { type: "OrderedCollection", totalItems: false },
      prev: { type: "Link", href: 123 },
      startIndex: -1,
    });
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [
        { reason: "invalid_value_shape", path: ["current", "startIndex"] },
        { reason: "invalid_value_shape", path: ["first", "items"] },
        { reason: "invalid_value_shape", path: ["last"] },
        { reason: "invalid_value_shape", path: ["partOf", "totalItems"] },
        { reason: "invalid_value_shape", path: ["prev", "href"] },
        { reason: "invalid_value_shape", path: ["startIndex"] },
      ],
    );
    const unsupported = validateDocument({
      "@context": context,
      type: "Note",
      items: like.object,
      totalItems: 1,
    });
    assert.equal(unsupported.complete, false);
    assert.ok(
      unsupported.diagnostics.every(
        ({ reason }) => reason === "unsupported_property",
      ),
    );
  });

  it("handles actor collection links, page cycles, and sparse member entries through shared traversal", () => {
    for (const type of [
      "Application",
      "Group",
      "Organization",
      "Person",
      "Service",
    ]) {
      assert.deepEqual(
        validateDocument({
          "@context": context,
          type,
          inbox: { type: "OrderedCollectionPage", startIndex: 0 },
          outbox: "https://example.com/outbox",
          following: { type: "OrderedCollection", totalItems: 0 },
          followers: { type: "CollectionPage" },
          liked: like.object,
        }),
        { complete: true, diagnostics: [], changes: [] },
      );
    }
    const page: Record<string, unknown> = { type: "CollectionPage" };
    page.next = page;
    const result = validateDocument({
      "@context": context,
      type: "Collection",
      first: page,
    });
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [{ reason: "non_json_value", path: ["first", "next"] }],
    );
    const items = [like.object];
    items.length = 2;
    const sparse = validateDocument({
      "@context": context,
      type: "Collection",
      items,
    });
    assert.deepEqual(
      sparse.diagnostics.map(({ reason, path }) => ({ reason, path })),
      [{ reason: "non_json_value", path: ["items", 1] }],
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
          { type: "Page" },
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

  it("keeps empty non-addressing and nested lists incomplete", () => {
    for (const [object, path] of [
      [[], ["object"]],
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
