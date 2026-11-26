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
import { CATALOG_NAME, parseCatalog, updateCatalog } from "./catalog.mts";
import {
  type CatalogEntry,
  type Expectation,
  differencesOf,
  quote,
} from "./namespace.mts";
import type { Report } from "./run.mts";

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

const proposalsOf = (
  catalog: ReadonlyMap<string, CatalogEntry>,
  reports: readonly Report[],
): readonly Proposal[] =>
  reports.flatMap(({ findings }) =>
    findings instanceof Error
      ? []
      : [...findings].flatMap(([iri, finding]) =>
          Object.entries(
            differencesOf(catalog.get(iri)!, finding.expected),
          ).map(([field, value]) => ({
            iri,
            field: field as keyof Expectation,
            value,
            origin: finding.origin,
          })),
        ),
  );

// Namespaces that give different values for the same field leave it alone.
const isConflicting =
  (proposals: readonly Proposal[]) =>
  (proposal: Proposal): boolean =>
    proposals.some(
      (other) =>
        other.iri === proposal.iri &&
        other.field === proposal.field &&
        quote(other.value) !== quote(proposal.value),
    );

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
  const proposals = proposalsOf(parseCatalog(text), reports);
  const conflicting = isConflicting(proposals);
  const accepted = proposals.filter((proposal) => !conflicting(proposal));
  const updates = updatesOf(accepted);
  const rewritten = updateCatalog(text, updates);
  const result = parseCatalog(rewritten);
  const unapplied = [...updates].filter(
    ([iri, fields]) =>
      Object.keys(differencesOf(result.get(iri)!, fields)).length > 0,
  );
  if (unapplied.length > 0) {
    throw new Error(
      `The update did not produce the values for ${unapplied.map(([iri]) => iri).join(", ")} in ${CATALOG_NAME}.`,
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
