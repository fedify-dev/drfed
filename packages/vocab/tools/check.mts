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
 * Checks the known property catalog against what the namespaces in
 * *namespaces.mts* publish, and lists the namespaces of the entries none of
 * them covers.  It changes nothing; *update.mts* writes the differences.
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import { CATALOG_URL, parseCatalog } from "./catalog.mts";
import { type CatalogEntry, messagesOf } from "./namespace.mts";
import {
  type Report,
  collectReports,
  entries,
  uncoveredNamespaces,
} from "./run.mts";

const printReport =
  (catalog: ReadonlyMap<string, CatalogEntry>) =>
  (report: Report): boolean => {
    if (report.findings instanceof Error) {
      console.error(`${report.name}: ${report.findings.message}`);
      return false;
    }
    const differing = [...report.findings].flatMap(([iri, finding]) => {
      const messages = messagesOf(catalog.get(iri)!, finding);
      return messages.length === 0 ? [] : [[iri, messages] as const];
    });
    const checked = report.findings.size;
    if (differing.length === 0) {
      console.log(
        `${report.name}: ${entries(checked)} ${checked === 1 ? "matches" : "match"}.`,
      );
      return true;
    }
    console.error(
      `${report.name}: ${differing.length} of ${entries(checked)} ${differing.length === 1 ? "differs" : "differ"}.`,
    );
    for (const [iri, messages] of differing) {
      for (const message of messages) console.error(`  ${iri}: ${message}`);
    }
    return false;
  };

const main = async (): Promise<number> => {
  const catalog = parseCatalog(await readFile(CATALOG_URL, "utf8"));
  const passed = (await collectReports(catalog)).map(printReport(catalog));
  const uncovered = uncoveredNamespaces(catalog);
  if (uncovered.size > 0) {
    console.log(
      "\nNot checked, since no namespace in namespaces.mts covers them:",
    );
    for (const [namespace, count] of uncovered) {
      console.log(`  ${namespace} (${count})`);
    }
  }
  if (passed.every(Boolean)) return 0;
  console.error(
    "\nRun `mise run update:known-properties` to write the values the namespaces give.",
  );
  return 1;
};

process.exitCode = await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  return 1;
});
