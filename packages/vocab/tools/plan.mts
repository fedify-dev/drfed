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
 * Plans an update of the known property catalog from the namespaces'
 * findings: which field values to write, and what is left for a person.
 */
import { FIELD_ORDER, parseCatalog, updateCatalog } from "./catalog.mts";
import {
  type CatalogEntry,
  type Expectation,
  differencesOf,
  quote,
  sameValue,
} from "./namespace.mts";
import type { Report } from "./reports.mts";

/** The value one namespace gives for one field of one entry. */
export interface Proposal {
  readonly iri: string;
  readonly field: keyof Expectation;
  readonly value: unknown;
  readonly origin: string;
}

/** What an update writes and leaves. */
export interface Plan {
  /** The rewritten catalog. */
  readonly text: string;
  /** The field values written, in catalog order. */
  readonly accepted: readonly Proposal[];
  /** What no field value fixes, for a person to resolve. */
  readonly unresolved: readonly string[];
}

// Every value that the namespaces give, whether or not the entry has it.
const proposalsOf = (reports: readonly Report[]): readonly Proposal[] =>
  reports.flatMap(({ findings }) =>
    findings instanceof Error
      ? []
      : [...findings].flatMap(([iri, finding]) =>
          Object.entries(finding.expected).flatMap(([field, value]) =>
            value === undefined
              ? []
              : [
                  {
                    iri,
                    field: field as keyof Expectation,
                    value,
                    origin: finding.origin,
                  },
                ],
          ),
        ),
  );

// Namespaces that give different values for the same field leave it alone,
// even when the entry has one of them.
const isConflicting =
  (proposals: readonly Proposal[]) =>
  (proposal: Proposal): boolean =>
    proposals.some(
      (other) =>
        other.iri === proposal.iri &&
        other.field === proposal.field &&
        !sameValue(proposal.field, other.value, proposal.value),
    );

// The proposal as the catalog writes it, or none when the entry has it.
const changesOf =
  (catalog: ReadonlyMap<string, CatalogEntry>) =>
  (proposal: Proposal): readonly Proposal[] => {
    const differences = differencesOf(catalog.get(proposal.iri)!, {
      [proposal.field]: proposal.value,
    });
    return proposal.field in differences
      ? [{ ...proposal, value: differences[proposal.field] }]
      : [];
  };

// Namespaces that agree on a field give one value, which is the first of
// theirs, since the catalog writes only one.
const firstPerField = (proposals: readonly Proposal[]): readonly Proposal[] =>
  [
    ...Map.groupBy(proposals, ({ iri, field }) => `${field} ${iri}`).values(),
  ].map(([first]) => first!);

const inCatalogOrder = (
  catalog: ReadonlyMap<string, CatalogEntry>,
): ((proposals: readonly Proposal[]) => readonly Proposal[]) => {
  const positions = new Map(
    [...catalog.keys()].map((iri, index) => [iri, index]),
  );
  return (proposals) =>
    proposals.toSorted(
      (left, right) =>
        positions.get(left.iri)! - positions.get(right.iri)! ||
        FIELD_ORDER.indexOf(left.field) - FIELD_ORDER.indexOf(right.field),
    );
};

const updatesOf = (
  proposals: readonly Proposal[],
): ReadonlyMap<string, Expectation> =>
  new Map(
    [...Map.groupBy(proposals, ({ iri }) => iri)].map(([iri, fields]) => [
      iri,
      Object.fromEntries(fields.map(({ field, value }) => [field, value])),
    ]),
  );

const problemsOf = (reports: readonly Report[]): readonly string[] =>
  reports.flatMap(({ name, findings }) =>
    findings instanceof Error
      ? [`${name}: ${findings.message}`]
      : [...findings].flatMap(([iri, { problems }]) =>
          problems.map((problem) => `${name}: ${iri}: ${problem}`),
        ),
  );

/**
 * Plans the update of a catalog, and confirms that the rewritten catalog has
 * the planned values.
 * @returns The plan.
 * @throws {Error} When the rewritten catalog lacks a planned value.
 */
export const planUpdate = (text: string, reports: readonly Report[]): Plan => {
  const proposals = proposalsOf(reports);
  const conflicting = isConflicting(proposals);
  const catalog = parseCatalog(text);
  const accepted = inCatalogOrder(catalog)(
    firstPerField(
      proposals
        .filter((proposal) => !conflicting(proposal))
        .flatMap(changesOf(catalog)),
    ),
  );
  const updates = updatesOf(accepted);
  const rewritten = updateCatalog(text, updates);
  const result = parseCatalog(rewritten);
  const unapplied = [...updates].filter(
    ([iri, fields]) =>
      Object.keys(differencesOf(result.get(iri)!, fields)).length > 0,
  );
  if (unapplied.length > 0) {
    throw new Error(
      `The update did not produce the values for ${unapplied.map(([iri]) => iri).join(", ")} in the catalog.`,
    );
  }
  return {
    text: rewritten,
    accepted,
    unresolved: [
      ...problemsOf(reports),
      ...proposals
        .filter(conflicting)
        .map(
          ({ iri, field, value, origin }) =>
            `${iri}: ${field} is left alone, since ${origin} gives ${quote(value)} and another namespace differs`,
        ),
    ],
  };
};
