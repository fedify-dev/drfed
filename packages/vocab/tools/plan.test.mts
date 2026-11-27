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

import type { Expectation } from "./namespace.mts";
import { planUpdate } from "./plan.mts";
import { type Report, UnreachableError } from "./reports.mts";

const IRI = "https://example.org/ns#a";
const R1 = "https://example.org/ns#R1";
const R2 = "https://example.org/ns#R2";

const catalogWith = (...fields: readonly string[]): string =>
  [
    `"${IRI}":`,
    "  label:",
    "    en: A",
    "  description:",
    "    en: Old.",
    ...fields,
    '  source: "https://example.org/doc#a"',
    "",
  ].join("\n");

const reportOf = (
  name: string,
  expected: Expectation,
  problems: readonly string[] = [],
): Report => ({
  name,
  findings: new Map([[IRI, { origin: name, expected, problems }]]),
});

describe("planUpdate", () => {
  it("writes the values that differ", () => {
    const plan = planUpdate(catalogWith(), [
      reportOf("One", { description: "New  text.", multiple: false }),
    ]);
    assert.match(plan.text, /en: >-\n {6}New text\.\n {2}multiple: false\n/u);
    assert.deepEqual(
      plan.accepted.map(({ field, value }) => [field, value]),
      [
        ["description", "New text."],
        ["multiple", false],
      ],
    );
    assert.deepEqual(plan.unresolved, []);
  });

  it("leaves a field alone when namespaces differ, even if one agrees", () => {
    const text = catalogWith("  multiple: true");
    const plan = planUpdate(text, [
      reportOf("One", { multiple: true }),
      reportOf("Two", { multiple: false }),
    ]);
    assert.equal(plan.text, text);
    assert.deepEqual(plan.accepted, []);
    assert.deepEqual(plan.unresolved, [
      `${IRI}: multiple is left alone, since One gives true and another namespace differs`,
      `${IRI}: multiple is left alone, since Two gives false and another namespace differs`,
    ]);
  });

  it("does not take ranges in another order for a conflict", () => {
    const plan = planUpdate(catalogWith(), [
      reportOf("One", { range: [R1, R2] }),
      reportOf("Two", { range: [R2, R1] }),
    ]);
    assert.deepEqual(plan.unresolved, []);
    assert.deepEqual(
      plan.accepted.map(({ value, origin }) => [value, origin]),
      [[[R1, R2], "One"]],
    );
    assert.match(
      plan.text,
      new RegExp(`range:\\n {4}- "${R1}"\\n {4}- "${R2}"\\n`, "u"),
    );
  });

  it("lists the values written in catalog order", () => {
    const other = "https://example.org/ns#b";
    const text = [
      catalogWith(),
      `"${other}":`,
      "  label:",
      "    en: B",
      "  description:",
      "    en: Old.",
      '  source: "https://example.org/doc#b"',
      "",
    ].join("\n");
    const plan = planUpdate(text, [
      {
        name: "One",
        findings: new Map([
          [
            other,
            { origin: "One", expected: { multiple: true }, problems: [] },
          ],
        ]),
      },
      reportOf("Two", { multiple: false, description: "New." }),
    ]);
    assert.deepEqual(
      plan.accepted.map(({ iri, field }) => [iri, field]),
      [
        [IRI, "description"],
        [IRI, "multiple"],
        [other, "multiple"],
      ],
    );
  });

  it("does not take descriptions that differ in whitespace for a conflict", () => {
    const plan = planUpdate(catalogWith(), [
      reportOf("One", { description: "New [ X ] text." }),
      reportOf("Two", { description: "New\n[X] text." }),
    ]);
    assert.deepEqual(plan.unresolved, []);
    assert.match(plan.text, /New \[X\] text\./u);
  });

  it("lists problems, failed namespaces, and skipped namespaces", () => {
    const plan = planUpdate(catalogWith(), [
      reportOf("One", {}, ["it is not defined"]),
      { name: "Two", findings: new Error("broken") },
      {
        name: "Three",
        findings: new UnreachableError(
          new Map([["https://example.org/doc", "fetch failed"]]),
        ),
      },
    ]);
    assert.deepEqual(plan.unresolved, [
      `One: ${IRI}: it is not defined`,
      "Two: broken",
      "Three: skipped, since a network problem kept https://example.org/doc from being fetched after 3 retries",
    ]);
  });
});
