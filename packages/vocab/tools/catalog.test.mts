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

import { parseCatalog, updateCatalog } from "./catalog.mts";

const IRI_A = "https://example.org/ns#a";
const IRI_B = "https://example.org/ns#b";
const R1 = "https://example.org/ns#R1";
const R2 = "https://example.org/ns#R2";

const lines = (...text: readonly string[]): string => `${text.join("\n")}\n`;

const entryOf = (iri: string, ...fields: readonly string[]): string =>
  lines(
    `"${iri}":`,
    "  label:",
    "    en: X",
    "  description:",
    "    en: >-",
    "      Old text that is folded",
    "      onto two lines.",
    ...fields,
    '  source: "https://example.org/doc#x"',
  );

const CATALOG = `# Extensions: https://example.org/ns#\n\n${entryOf(
  IRI_A,
  "  range:",
  `    - "${R1}"`,
  "  multiple: true",
)}\n${entryOf(IRI_B)}`;

describe("parseCatalog", () => {
  it("returns the entries in catalog order", () => {
    const catalog = parseCatalog(CATALOG);
    assert.deepEqual([...catalog.keys()], [IRI_A, IRI_B]);
    assert.deepEqual(catalog.get(IRI_A)?.range, [R1]);
  });

  it("rejects duplicate keys and a catalog that is not a mapping", () => {
    assert.throws(() => parseCatalog(`${entryOf(IRI_A)}${entryOf(IRI_A)}`));
    assert.throws(() => parseCatalog("- a\n"), TypeError);
  });
});

describe("updateCatalog", () => {
  const update = (fields: object, text = CATALOG, iri = IRI_A): string =>
    updateCatalog(text, new Map([[iri, fields]]));

  it("rewrites only the lines of the changed field", () => {
    assert.equal(
      update({ multiple: false }),
      CATALOG.replace("  multiple: true\n", "  multiple: false\n"),
    );
  });

  it("folds a description to the line width", () => {
    const text = `${"word ".repeat(20).trim()}.`;
    const result = parseCatalog(update({ description: text }));
    assert.equal(result.get(IRI_A)?.description.en, text);
    for (const line of update({ description: text }).split("\n")) {
      assert.ok(line.length <= 80, line);
    }
  });

  it("quotes a description that folding would change", () => {
    for (const text of [
      "First line.\nSecond line.",
      `  ${"word ".repeat(25).trim()}`,
      `${"a".repeat(74)}  ${"b".repeat(40)}`,
      "Trailing space. ",
    ]) {
      const result = update({ description: text });
      assert.equal(parseCatalog(result).get(IRI_A)?.description.en, text);
      assert.match(result, /\n {4}en: "/u);
    }
  });

  it("replaces a range and removes an empty one", () => {
    assert.match(
      update({ range: [R2, R1] }),
      new RegExp(`  range:\\n    - "${R2}"\\n    - "${R1}"\\n  multiple`, "u"),
    );
    assert.doesNotMatch(update({ range: [] }), /range:/u);
  });

  it("inserts missing fields in field order", () => {
    const result = update({ multiple: false, range: [R1] }, CATALOG, IRI_B);
    assert.match(
      result,
      new RegExp(
        `onto two lines\\.\\n  range:\\n    - "${R1}"\\n  multiple: false\\n  source:`,
        "u",
      ),
    );
    assert.deepEqual(parseCatalog(result).get(IRI_B)?.range, [R1]);
  });

  it("does not insert an empty range", () => {
    assert.equal(update({ range: [] }, CATALOG, IRI_B), CATALOG);
  });

  it("inserts a field before the comment above the next field", () => {
    // Only the entry of B has `source` right after its description.
    const text = CATALOG.replace(
      "onto two lines.\n  source:",
      "onto two lines.\n  # Why the source is this.\n  source:",
    );
    assert.match(
      update({ multiple: false }, text, IRI_B),
      /lines\.\n {2}multiple: false\n {2}# Why the source is this\.\n {2}source:/u,
    );
  });

  it("does not take a more indented # line of a scalar for a comment", () => {
    const text = lines(
      `"${IRI_A}":`,
      "  description:",
      "    en: |-",
      "      Text.",
      "      # Not a comment.",
      '  source: "https://example.org/doc#x"',
    );
    assert.match(
      update({ multiple: false }, text),
      /# Not a comment\.\n {2}multiple: false\n {2}source:/u,
    );
  });

  it("ends the last line before appending at the end of a file", () => {
    const text = `"${IRI_A}":\n  description:\n    en: Old.`;
    assert.equal(
      update({ source: "https://example.org/doc#x" }, text),
      `${text}\n  source: "https://example.org/doc#x"\n`,
    );
  });

  it("replaces only the value of a description in a flow mapping", () => {
    const text = lines(
      `"${IRI_A}":`,
      "  label:",
      "    en: X",
      "  description: { en: Old., ko: 이전 }",
      '  source: "https://example.org/doc#x"',
    );
    const result = update({ description: "New: text." }, text);
    assert.equal(
      result,
      text.replace("{ en: Old., ko:", '{ en: "New: text.", ko:'),
    );
    assert.deepEqual(parseCatalog(result).get(IRI_A)?.description, {
      en: "New: text.",
      ko: "이전",
    });
  });

  it("rejects an entry written as a flow mapping", () => {
    const text = `"${IRI_A}": { description: { en: Old. }, source: "https://example.org/doc#x" }\n`;
    assert.throws(
      () => update({ multiple: false }, text),
      /is a flow mapping/u,
    );
  });

  it("rejects a catalog that does not parse", () => {
    assert.throws(
      () => update({ multiple: false }, `${entryOf(IRI_A)}${entryOf(IRI_A)}`),
      /The catalog does not parse/u,
    );
    assert.throws(
      () => update({ multiple: false }, '"x": ['),
      /The catalog does not parse/u,
    );
  });

  it("rejects an IRI the catalog has no entry for", () => {
    assert.throws(
      () => update({ multiple: false }, CATALOG, "https://example.org/ns#c"),
      /no entry/u,
    );
  });
});
