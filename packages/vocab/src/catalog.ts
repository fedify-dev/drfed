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

/**
 * Build-time compilation of the known property catalog.  This module is not a
 * package entry: it runs inside the `tsdown` build, so that the published
 * package carries the validated data without the YAML source, the schema, or
 * the parsers.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type OutputUnit,
  type SchemaObject,
  registerSchema,
  setShouldValidateFormat,
  unregisterSchema,
  validate,
} from "@hyperjump/json-schema/draft-2020-12";
import { BASIC } from "@hyperjump/json-schema/experimental";
// Registers the `format` validators, including `iri`, as a side effect.
// oxlint-disable-next-line import/no-unassigned-import
import "@hyperjump/json-schema/formats";
import type { TsdownPlugin } from "tsdown";
import { parse } from "yaml";

import type { KnownProperties } from "./known-properties.ts";

const CATALOG_PATH = fileURLToPath(
  new URL("./properties.yaml", import.meta.url),
);
const SCHEMA_PATH = fileURLToPath(
  new URL("./properties.schema.yaml", import.meta.url),
);
const PLUGIN_NAME = "drfed:known-properties";

/** The catalog or its schema failed to parse or to validate. */
export class CatalogError extends Error {
  override name = "CatalogError";
}

const parseYaml = (text: string, source: string): unknown => {
  try {
    // `yaml` rejects duplicate mapping keys unless `uniqueKeys` is disabled.
    return parse(text, { uniqueKeys: true });
  } catch (error) {
    throw new CatalogError(`${source}: ${(error as Error).message}`, {
      cause: error,
    });
  }
};

const isSchemaObject = (value: unknown): value is SchemaObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodePointer = (pointer: string): string =>
  pointer
    .replace(/^#/u, "")
    .split("/")
    .slice(1)
    .map((token) =>
      decodeURIComponent(token).replaceAll("~1", "/").replaceAll("~0", "~"),
    )
    .join(" > ");

const keywordOf = (unit: OutputUnit): string =>
  unit.absoluteKeywordLocation.split("/").at(-1) ?? unit.keyword;

/**
 * Flattens validation output into the leaf failures, which name the keyword
 * that rejected the value rather than the applicators above it.
 * @param units The output units of a failed validation.
 * @returns The output units that have no nested errors.
 */
const leafFailures = (units: readonly OutputUnit[]): readonly OutputUnit[] =>
  units.flatMap((unit) =>
    unit.errors?.length ? leafFailures(unit.errors) : [unit],
  );

const describeFailure = (unit: OutputUnit): string => {
  const location = decodePointer(unit.instanceLocation);
  return `${location === "" ? "(catalog)" : location}: ${keywordOf(unit)}`;
};

/**
 * Parses and validates the catalog against its JSON Schema, with format
 * assertions enabled.
 * @param catalogText The YAML text of the catalog.
 * @param schemaText The YAML text of the catalog's JSON Schema.
 * @returns The validated catalog data.
 * @throws {CatalogError} When either text fails to parse, the catalog has
 *   duplicate keys, or the catalog does not satisfy the schema.
 */
export const compileCatalog = async (
  catalogText: string,
  schemaText: string,
): Promise<KnownProperties> => {
  const catalog = parseYaml(catalogText, "properties.yaml");
  const schema = parseYaml(schemaText, "properties.schema.yaml");
  if (!isSchemaObject(schema)) {
    throw new CatalogError("properties.schema.yaml: not a JSON Schema object");
  }
  // The schema registry is global, so each compilation registers its schema
  // under a fresh URI and removes it afterwards.
  const schemaUri = `urn:uuid:${randomUUID()}`;
  registerSchema(schema, schemaUri);
  try {
    setShouldValidateFormat(true);
    const output = await validate(schemaUri, catalog as SchemaObject, BASIC);
    if (!output.valid) {
      const failures = [
        ...new Set(leafFailures(output.errors ?? []).map(describeFailure)),
      ];
      throw new CatalogError(
        `properties.yaml does not match its schema:\n${failures
          .map((failure) => `  - ${failure}`)
          .join("\n")}`,
      );
    }
  } finally {
    unregisterSchema(schemaUri);
  }
  return catalog as KnownProperties;
};

/**
 * Renders validated catalog data as a JavaScript module whose default export
 * is the data as an object literal.
 * @param catalog The validated catalog data.
 * @returns The module source.
 */
export const renderCatalogModule = (catalog: KnownProperties): string =>
  `export default ${JSON.stringify(catalog, null, 2)};\n`;

/**
 * A `tsdown` plugin that turns *src/properties.yaml* into a JavaScript module
 * after validating it against *src/properties.schema.yaml*.  It leaves every
 * other module alone, and watch builds rebuild when either file changes.
 * @returns The plugin.
 */
export const knownPropertiesPlugin = (): TsdownPlugin => ({
  name: PLUGIN_NAME,
  async load(id) {
    // The path is native, while an id may use forward slashes on Windows.
    if (resolve(id) !== CATALOG_PATH) return null;
    // Rolldown does not watch a module whose source a plugin loads, so both
    // files are registered.
    this.addWatchFile(CATALOG_PATH);
    this.addWatchFile(SCHEMA_PATH);
    const [catalogText, schemaText] = await Promise.all([
      readFile(CATALOG_PATH, "utf-8"),
      readFile(SCHEMA_PATH, "utf-8"),
    ]);
    try {
      return renderCatalogModule(await compileCatalog(catalogText, schemaText));
    } catch (error) {
      if (error instanceof CatalogError) this.error(error.message);
      throw error;
    }
  },
});
