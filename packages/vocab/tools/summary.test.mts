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

import type { CatalogEntry } from "./namespace.mts";
import { type Report, UnreachableError } from "./reports.mts";
import { summarizeReports } from "./summary.mts";

const IRI = "https://example.org/ns#a";
const CATALOG: ReadonlyMap<string, CatalogEntry> = new Map([
  [IRI, { description: { en: "A." }, multiple: true, source: "https://e/" }],
]);

const matching: Report = {
  name: "Matching",
  findings: new Map([[IRI, { origin: "M", expected: {}, problems: [] }]]),
};
const differing: Report = {
  name: "Differing",
  findings: new Map([
    [IRI, { origin: "D", expected: { multiple: false }, problems: [] }],
  ]),
};
const failed: Report = { name: "Failed", findings: new Error("broken") };
const skipped: Report = {
  name: "Skipped",
  findings: new UnreachableError(
    new Map([
      ["https://example.org/one", "fetch failed (ENOTFOUND)"],
      ["https://example.org/two", "answered 503"],
    ]),
  ),
};

const textsOf = (reports: readonly Report[]) =>
  summarizeReports(CATALOG, reports).lines.map(({ severity, text, detail }) => [
    severity,
    text,
    detail,
  ]);

describe("summarizeReports", () => {
  it("passes when every entry matches", () => {
    const summary = summarizeReports(CATALOG, [matching]);
    assert.equal(summary.passed, true);
    assert.deepEqual(textsOf([matching]), [
      ["info", "Matching: 1 entry matches.", false],
    ]);
  });

  it("passes a skipped namespace with a warning naming every URL", () => {
    assert.equal(summarizeReports(CATALOG, [matching, skipped]).passed, true);
    assert.deepEqual(textsOf([skipped]), [
      [
        "warning",
        `Skipped: ${skipped.findings instanceof Error ? skipped.findings.message : ""}.`,
        false,
      ],
      ["warning", "  https://example.org/one: fetch failed (ENOTFOUND)", true],
      ["warning", "  https://example.org/two: answered 503", true],
      [
        "warning",
        "1 of 1 namespace was skipped for network problems, so their entries were not checked: Skipped.",
        false,
      ],
    ]);
  });

  it("fails a namespace that failed, even beside a skipped one", () => {
    const summary = summarizeReports(CATALOG, [skipped, failed]);
    assert.equal(summary.passed, false);
    assert.ok(
      summary.lines.some(
        ({ severity, text }) =>
          severity === "error" && text === "Failed: broken",
      ),
    );
  });

  it("fails and lists the entries that differ", () => {
    assert.equal(summarizeReports(CATALOG, [differing]).passed, false);
    assert.deepEqual(textsOf([differing]), [
      ["error", "Differing: 1 of 1 entry differs.", false],
      ["error", `  ${IRI}: multiple is true, but D gives false`, true],
    ]);
  });
});
