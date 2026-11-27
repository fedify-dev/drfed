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
import { sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CatalogError,
  compileCatalog,
  knownPropertiesPlugin,
  renderCatalogModule,
} from "./compile.mts";

const AS = "https://www.w3.org/ns/activitystreams#";
const GTS = "https://gotosocial.org/ns#";
const LOOPS = "https://joinloops.org/ns#";
const SOURCE = "https://www.w3.org/TR/activitystreams-vocabulary/#dfn-actor";

const siblingPath = (name: string): string =>
  fileURLToPath(new URL(`../src/${name}`, import.meta.url));

const readSibling = (name: string): Promise<string> =>
  readFile(siblingPath(name), "utf-8");

const schemaText = await readSibling("properties.schema.yaml");

const entry = (key: string, body: string): string =>
  `${JSON.stringify(key)}:\n${body
    .trim()
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}\n`;

const ACTOR_BODY = `
label:
  en: Actor
description:
  en: Identifies one or more entities that performed the activity.
range:
  - "${AS}Object"
  - "${AS}Link"
multiple: true
source: "${SOURCE}"
`;

const rejects = (catalogText: string, pattern: RegExp): Promise<void> =>
  assert.rejects(compileCatalog(catalogText, schemaText), {
    name: CatalogError.name,
    message: pattern,
  });

describe("compileCatalog()", () => {
  it("accepts the repository's catalog", async () => {
    const catalog = await compileCatalog(
      await readSibling("properties.yaml"),
      schemaText,
    );
    assert.ok(catalog[`${AS}actor`]);
  });

  it("accepts a minimal entry and keeps its fields", async () => {
    const catalog = await compileCatalog(
      entry(`${AS}actor`, ACTOR_BODY),
      schemaText,
    );
    assert.deepEqual(catalog[`${AS}actor`]?.range, [
      `${AS}Object`,
      `${AS}Link`,
    ]);
    assert.equal(catalog[`${AS}actor`]?.multiple, true);
  });

  it("keeps entries that share a label but differ in IRI", async () => {
    const body = `
label:
  en: Interaction policy
description:
  en: The interaction policy.
source: "https://example.com/docs"
`;
    const catalog = await compileCatalog(
      entry(`${GTS}interactionPolicy`, body) +
        entry(`${LOOPS}interactionPolicy`, body),
      schemaText,
    );
    assert.deepEqual(Object.keys(catalog), [
      `${GTS}interactionPolicy`,
      `${LOOPS}interactionPolicy`,
    ]);
  });

  it("rejects duplicate IRI keys", () =>
    rejects(
      entry(`${AS}actor`, ACTOR_BODY) + entry(`${AS}actor`, ACTOR_BODY),
      /unique/iu,
    ));

  it("rejects a key written as an alias of an earlier key", () =>
    rejects(
      `? &actor "${AS}actor"\n: ${JSON.stringify({ label: { en: "A" } })}\n` +
        `? *actor\n: ${JSON.stringify({ label: { en: "B" } })}\n`,
      /alias \*actor is used as a mapping key/u,
    ));

  it("rejects a key written as an alias inside an entry", () =>
    rejects(
      entry(
        `${AS}actor`,
        ACTOR_BODY.replace(
          "  en: Actor",
          "  &english en: Actor\n  *english : B",
        ),
      ),
      /alias \*english is used as a mapping key/u,
    ));

  it("rejects a key that is not an absolute IRI", () =>
    rejects(entry("actor", ACTOR_BODY), /format/u));

  it("rejects a label without English text", () =>
    rejects(
      entry(`${AS}actor`, ACTOR_BODY.replace("  en: Actor", "  ko: 행위자")),
      /label: required/u,
    ));

  it("rejects a description without English text", () =>
    rejects(
      entry(
        `${AS}actor`,
        ACTOR_BODY.replace("  en: Identifies", "  ko: Identifies"),
      ),
      /description: required/u,
    ));

  it("rejects empty English text", () =>
    rejects(
      entry(`${AS}actor`, ACTOR_BODY.replace("  en: Actor", '  en: ""')),
      /label > en: minLength/u,
    ));

  it("rejects English text of whitespace alone", async () => {
    await rejects(
      entry(`${AS}actor`, ACTOR_BODY.replace("  en: Actor", '  en: "   "')),
      /label > en: pattern/u,
    );
    await rejects(
      entry(
        `${AS}actor`,
        ACTOR_BODY.replace(
          "  en: Identifies one or more entities that performed the activity.",
          '  en: "\\t"',
        ),
      ),
      /description > en: pattern/u,
    );
  });

  it("keeps text with whitespace between its words", async () => {
    const catalog = await compileCatalog(
      entry(
        `${AS}actor`,
        ACTOR_BODY.replace("  en: Actor", '  en: "Actor  name"'),
      ),
      schemaText,
    );
    assert.equal(catalog[`${AS}actor`]?.label.en, "Actor  name");
  });

  it("rejects a language that is not a language tag", () =>
    rejects(
      entry(
        `${AS}actor`,
        ACTOR_BODY.replace("  en: Actor", "  en: Actor\n  fr_CA: Acteur"),
      ),
      /label > fr_CA: pattern/u,
    ));

  it("accepts languages written as RFC 5646 language tags", async () => {
    const tags = ["fr-CA", "zh-Hant-TW", "de-CH-1996", "EN-GB-OED", "x-drfed"];
    const labels = tags.map((tag) => `  ${tag}: Actor`).join("\n");
    const catalog = await compileCatalog(
      entry(
        `${AS}actor`,
        ACTOR_BODY.replace("  en: Actor", `  en: Actor\n${labels}`),
      ),
      schemaText,
    );
    assert.deepEqual(Object.keys(catalog[`${AS}actor`]?.label ?? {}), [
      "en",
      ...tags,
    ]);
  });

  it("rejects an entry without a source", () =>
    rejects(
      entry(`${AS}actor`, ACTOR_BODY.replace(`source: "${SOURCE}"`, "")),
      /actor: required/u,
    ));

  it("rejects a blank node identifier as a key", () =>
    rejects(entry("_:actor", ACTOR_BODY), /_:actor: format/u));

  it("rejects a range with a relative IRI", () =>
    rejects(
      entry(`${AS}actor`, ACTOR_BODY.replace(`"${AS}Link"`, "Link")),
      /range > 1: format/u,
    ));

  it("rejects a range with a blank node identifier", () =>
    rejects(
      entry(`${AS}actor`, ACTOR_BODY.replace(`"${AS}Link"`, '"_:Link"')),
      /range > 1: format/u,
    ));

  it("rejects an empty range", () =>
    rejects(
      entry(
        `${AS}actor`,
        ACTOR_BODY.replace(`  - "${AS}Object"\n  - "${AS}Link"`, "").replace(
          "range:",
          "range: []",
        ),
      ),
      /range: minItems/u,
    ));

  it("rejects an unknown field", () =>
    rejects(
      entry(`${AS}actor`, `${ACTOR_BODY}\nfunctional: true`),
      /additionalProperties/u,
    ));

  it("rejects an empty catalog", () => rejects("{}\n", /minProperties/u));

  it("rejects YAML that does not parse", () =>
    rejects(`"${AS}actor": [\n`, /properties\.yaml/u));
});

describe("renderCatalogModule()", () => {
  it("exports the data as an object literal", async () => {
    const catalog = await compileCatalog(
      entry(`${AS}actor`, ACTOR_BODY),
      schemaText,
    );
    const source = renderCatalogModule(catalog);
    assert.match(source, /^export default \{/u);
    assert.doesNotMatch(source, /\bimport\b/u);
  });
});

interface LoadCall {
  readonly result: unknown;
  readonly watchFiles: readonly string[];
}

const load = async (id: string): Promise<LoadCall> => {
  const hook = knownPropertiesPlugin().load;
  assert.ok(hook);
  const handler = typeof hook === "function" ? hook : hook.handler;
  const watchFiles: string[] = [];
  const context = {
    addWatchFile: (file: string) => {
      watchFiles.push(file);
    },
    error: (message: string) => {
      throw new Error(message);
    },
  } as unknown as ThisParameterType<typeof handler>;
  const result = await handler.call(context, id);
  return { result, watchFiles };
};

describe("knownPropertiesPlugin()", () => {
  it("leaves other modules alone", async () => {
    const { result, watchFiles } = await load(fileURLToPath(import.meta.url));
    assert.equal(result, null);
    assert.deepEqual(watchFiles, []);
  });

  it("loads the catalog as a module and watches it with its schema", async () => {
    const { result, watchFiles } = await load(siblingPath("properties.yaml"));
    assert.equal(typeof result, "string");
    assert.match(String(result), /^export default \{/u);
    assert.deepEqual(watchFiles, [
      siblingPath("properties.yaml"),
      siblingPath("properties.schema.yaml"),
    ]);
  });

  it("recognizes the catalog by an id with forward slashes", async () => {
    const id = siblingPath("properties.yaml").split(sep).join("/");
    const { result } = await load(id);
    assert.equal(typeof result, "string");
  });
});
