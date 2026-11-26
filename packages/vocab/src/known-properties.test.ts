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
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import {
  type KnownProperties,
  knownProperties,
} from "@drfed/vocab/known-properties";

const AS = "https://www.w3.org/ns/activitystreams#";
const ACTOR = `${AS}actor`;
const DIST_MODULE = createRequire(import.meta.url).resolve(
  "@drfed/vocab/known-properties",
);

const isAbsoluteIri = (key: string): boolean =>
  URL.canParse(key) && !key.startsWith("_:");

describe("knownProperties", () => {
  it("describes actor as the Activity Vocabulary defines it", () => {
    const actor = knownProperties[ACTOR];
    assert.ok(actor);
    assert.equal(actor.label.en, "Actor");
    assert.match(actor.description.en, /performed or are expected to perform/u);
    assert.deepEqual(actor.range, [`${AS}Object`, `${AS}Link`]);
    assert.equal(actor.multiple, true);
    assert.equal(
      actor.source,
      "https://www.w3.org/TR/activitystreams-vocabulary/#dfn-actor",
    );
  });

  it("returns undefined for an unlisted IRI", () => {
    assert.equal(knownProperties["https://example.com/ns#unlisted"], undefined);
    assert.equal(knownProperties["actor"], undefined);
  });

  it("types a lookup as possibly undefined", () => {
    // An indexed access type ignores noUncheckedIndexedAccess, so this fails
    // to type-check if the declared lookup type ever drops undefined.
    const mayMiss: undefined extends KnownProperties[string] ? true : false =
      true;
    assert.ok(mayMiss);
  });

  it("returns undefined for Object.prototype members", () => {
    assert.equal(Object.getPrototypeOf(knownProperties), null);
    for (const key of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ]) {
      assert.equal(knownProperties[key], undefined, key);
    }
  });

  it("enumerates entries keyed by absolute IRIs", () => {
    const keys = Object.keys(knownProperties);
    assert.ok(keys.length > 1);
    assert.ok(keys.includes(ACTOR));
    for (const key of keys) assert.ok(isAbsoluteIri(key), key);
  });

  it("gives every entry English text and a source", () => {
    for (const [iri, entry] of Object.entries(knownProperties)) {
      assert.ok(entry, iri);
      assert.ok(entry.label.en.length > 0, iri);
      assert.ok(entry.description.en.length > 0, iri);
      assert.ok(URL.canParse(entry.source), iri);
      for (const type of entry.range ?? []) assert.ok(isAbsoluteIri(type), iri);
    }
  });

  it("is frozen together with its entries", () => {
    assert.ok(Object.isFrozen(knownProperties));
    const actor = knownProperties[ACTOR];
    assert.ok(actor);
    assert.ok(Object.isFrozen(actor));
    assert.ok(Object.isFrozen(actor.label));
    assert.ok(Object.isFrozen(actor.range));
  });

  it("is built without YAML imports or import attributes", async () => {
    const source = await readFile(DIST_MODULE, "utf-8");
    assert.doesNotMatch(source, /^\s*import\b/mu);
    assert.doesNotMatch(source, /\bimport\s*\(/u);
    assert.doesNotMatch(source, /\bwith\s*\{/u);
  });
});
