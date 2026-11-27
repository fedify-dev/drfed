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
// oxlint-disable no-console

/**
 * Writes into the known property catalog the field values that the
 * namespaces in *namespaces.mts* give, and lists what no field value can
 * fix, such as an IRI that its namespace does not define.
 */
import { writeFile } from "node:fs/promises";
import process from "node:process";

import { parseCatalog } from "./catalog.mts";
import { quote } from "./namespace.mts";
import { NAMESPACES } from "./namespaces.mts";
import { planUpdate } from "./plan.mts";
import { collectReports } from "./reports.mts";
import { CATALOG_NAME, CATALOG_URL, entries, readCatalog } from "./shared.mts";

const main = async (): Promise<number> => {
  const text = await readCatalog();
  const plan = planUpdate(
    text,
    await collectReports(parseCatalog(text), NAMESPACES),
  );
  if (plan.text !== text) await writeFile(CATALOG_URL, plan.text);
  const updated = new Set(plan.accepted.map(({ iri }) => iri)).size;
  console.log(
    `Updated ${entries(updated)} of ${CATALOG_NAME}${updated === 0 ? "." : ":"}`,
  );
  for (const { iri, field, value, origin } of plan.accepted) {
    console.log(`  ${iri}: ${field} is now ${quote(value)}, from ${origin}`);
  }
  if (plan.unresolved.length === 0) return 0;
  console.error("\nLeft for a person to resolve:");
  for (const line of plan.unresolved) console.error(`  ${line}`);
  return 1;
};

process.exitCode = await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  return 1;
});
