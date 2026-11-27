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
 * Where the check and the update find the catalog in the repository, how
 * they read it, and how they print counts.
 */
import { readFile } from "node:fs/promises";

import { compileCatalog } from "../src/catalog.ts";

export const CATALOG_URL = new URL("../src/properties.yaml", import.meta.url);
export const CATALOG_NAME = "packages/vocab/src/properties.yaml";
export const SCHEMA_URL = new URL(
  "../src/properties.schema.yaml",
  import.meta.url,
);

/**
 * Formats a count of entries.
 * @returns The count with the noun in the right number.
 */
export const entries = (count: number): string =>
  `${count} ${count === 1 ? "entry" : "entries"}`;

/**
 * Reads the catalog and validates it against its schema, as the build does,
 * so that an entry of the wrong shape is reported by name before anything
 * reads its fields.
 * @returns The text of the catalog.
 * @throws {CatalogError} When the catalog does not satisfy its schema.
 */
export const readCatalog = async (): Promise<string> => {
  const text = await readFile(CATALOG_URL, "utf8");
  await compileCatalog(text, await readFile(SCHEMA_URL, "utf8"));
  return text;
};
