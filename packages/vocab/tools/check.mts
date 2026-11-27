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
import { appendFile } from "node:fs/promises";
import process from "node:process";

import { parseCatalog } from "./catalog.mts";
import { NAMESPACES } from "./namespaces.mts";
import {
  RUNNER_TRANSIENT_STATUSES,
  TRANSIENT_STATUSES,
  collectReports,
  uncoveredNamespaces,
} from "./reports.mts";
import { readCatalog } from "./shared.mts";
import { type SummaryLine, summarizeReports } from "./summary.mts";

const print = ({ severity, text }: SummaryLine): void => {
  if (severity === "info") console.log(text);
  else if (severity === "error") console.error(text);
  else console.warn(text);
};

// GitHub Actions shows the job summary on the run's page, where a skipped
// namespace is not lost in the log of a passing job.  A warning command
// would not do: `mise run check` prefixes the lines of each task it runs,
// and the runner reads a command only at the start of a line.
const summarizeWarnings = async (
  lines: readonly SummaryLine[],
): Promise<void> => {
  const path = process.env["GITHUB_STEP_SUMMARY"];
  const warnings = lines.filter(({ severity }) => severity === "warning");
  if (path === undefined || path === "" || warnings.length === 0) return;
  const items = warnings.map(({ text, detail }) =>
    detail ? `   -  ${text.trim()}` : ` -  ${text}`,
  );
  await appendFile(
    path,
    `### Known property catalog\n\n${items.join("\n")}\n\n`,
  );
};

const main = async (): Promise<number> => {
  const catalog = parseCatalog(await readCatalog());
  const summary = summarizeReports(
    catalog,
    await collectReports(catalog, NAMESPACES, {
      // A host that refuses the runner with 403 is skipped there with a
      // warning, but still fails the check everywhere else.
      transientStatuses:
        process.env["GITHUB_ACTIONS"] === "true"
          ? RUNNER_TRANSIENT_STATUSES
          : TRANSIENT_STATUSES,
    }),
  );
  for (const line of summary.lines) print(line);
  await summarizeWarnings(summary.lines);
  const uncovered = uncoveredNamespaces(catalog, NAMESPACES);
  if (uncovered.size > 0) {
    console.log(
      "\nNot checked, since no namespace in namespaces.mts covers them:",
    );
    for (const [namespace, count] of uncovered) {
      console.log(`  ${namespace} (${count})`);
    }
  }
  if (summary.passed) return 0;
  console.error(
    "\nRun `mise run update:known-properties` to write the values the namespaces give.",
  );
  return 1;
};

process.exitCode = await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  return 1;
});
