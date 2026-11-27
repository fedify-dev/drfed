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
 * Turns the reports of a check into the lines it prints and whether it
 * passes: a namespace skipped for a network problem passes with a warning
 * that names the URLs, and one that failed or whose entries differ fails.
 */
import { type CatalogEntry, messagesOf } from "./namespace.mts";
import { type Report, UnreachableError } from "./reports.mts";

/** One line of a check's output. */
export interface SummaryLine {
  /** `warning` and `error` go to standard error. */
  readonly severity: "info" | "warning" | "error";
  readonly text: string;
  /** Whether the line details the line before it, indented. */
  readonly detail: boolean;
}

/** What a check prints, and whether it passes. */
export interface CheckSummary {
  readonly passed: boolean;
  readonly lines: readonly SummaryLine[];
}

const line = (
  severity: SummaryLine["severity"],
  text: string,
  detail = false,
): SummaryLine => ({ severity, text, detail });

const entriesOf = (count: number): string =>
  `${count} ${count === 1 ? "entry" : "entries"}`;

const summaryOf =
  (catalog: ReadonlyMap<string, CatalogEntry>) =>
  (report: Report): CheckSummary => {
    const { name, findings } = report;
    if (findings instanceof UnreachableError) {
      return {
        passed: true,
        lines: [
          line("warning", `${name}: ${findings.message}.`),
          ...[...findings.failures].map(([url, reason]) =>
            line("warning", `  ${url}: ${reason}`, true),
          ),
        ],
      };
    }
    if (findings instanceof Error) {
      return {
        passed: false,
        lines: [line("error", `${name}: ${findings.message}`)],
      };
    }
    const differing = [...findings].flatMap(([iri, finding]) => {
      const messages = messagesOf(catalog.get(iri)!, finding);
      return messages.length === 0 ? [] : [[iri, messages] as const];
    });
    const checked = findings.size;
    if (differing.length === 0) {
      return {
        passed: true,
        lines: [
          line(
            "info",
            `${name}: ${entriesOf(checked)} ${checked === 1 ? "matches" : "match"}.`,
          ),
        ],
      };
    }
    return {
      passed: false,
      lines: [
        line(
          "error",
          `${name}: ${differing.length} of ${entriesOf(checked)} ${differing.length === 1 ? "differs" : "differ"}.`,
        ),
        ...differing.flatMap(([iri, messages]) =>
          messages.map((message) =>
            line("error", `  ${iri}: ${message}`, true),
          ),
        ),
      ],
    };
  };

/**
 * Summarizes the reports of a check, one block of lines per report in their
 * order, then a warning that counts the namespaces skipped for network
 * problems, if any.
 * @returns The lines, and whether every report passes.
 */
export const summarizeReports = (
  catalog: ReadonlyMap<string, CatalogEntry>,
  reports: readonly Report[],
): CheckSummary => {
  const summaries = reports.map(summaryOf(catalog));
  const skipped = reports.filter(
    ({ findings }) => findings instanceof UnreachableError,
  );
  return {
    passed: summaries.every(({ passed }) => passed),
    lines: [
      ...summaries.flatMap(({ lines }) => lines),
      ...(skipped.length === 0
        ? []
        : [
            line(
              "warning",
              `${skipped.length} of ${reports.length} ${skipped.length === 1 ? "namespace was" : "namespaces were"} skipped for network problems, so their entries were not checked: ${skipped.map(({ name }) => name).join(", ")}.`,
            ),
          ]),
    ],
  };
};
