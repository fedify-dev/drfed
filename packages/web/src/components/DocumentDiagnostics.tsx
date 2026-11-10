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

import { type Accessor, For, Show, createContext, useContext } from "solid-js";

import styles from "~/styles/resource.module.css";

/** The source keys and list indexes leading to a value of a document. */
export type FieldPath = readonly (string | number)[];

/** A finding of the document validator, as GraphQL returns it. */
export interface Diagnostic {
  readonly reason: string;
  readonly category: string;
  readonly severity: string;
  /** A {@link FieldPath} as JSON. */
  readonly path: unknown;
  readonly message: string;
}

/**
 * Reads a source path from a JSON field.
 * @returns The path, or `undefined` when the value is not one.
 */
export const fieldPath = (value: unknown): FieldPath | undefined =>
  Array.isArray(value) &&
  value.every((segment) => ["string", "number"].includes(typeof segment))
    ? (value as FieldPath)
    : undefined;

const pathKey = (path: FieldPath): string => JSON.stringify(path);

const leadsTo = (prefix: FieldPath, path: FieldPath): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

/** Findings placed beside the document nodes a revision renders. */
export interface DiagnosticPlacement<T extends Diagnostic> {
  /** Finds the findings placed beside the node at a path. */
  readonly at: (path: unknown) => readonly T[];
  /** The findings no rendered node leads to, in their original order. */
  readonly unplaced: readonly T[];
}

/**
 * Places each finding beside the deepest rendered node whose path is a
 * prefix of the finding's path, so that it shows where it applies.
 * @param nodePaths The paths of the rendered nodes.
 * @param diagnostics The findings, in their original order.
 * @returns The placement.
 */
export function placeDiagnostics<T extends Diagnostic>(
  nodePaths: readonly unknown[],
  diagnostics: readonly T[],
): DiagnosticPlacement<T> {
  const paths = nodePaths
    .map((path) => fieldPath(path))
    .filter((path) => path !== undefined)
    .toSorted((shallower, deeper) => deeper.length - shallower.length);
  const placed = new Map<string, T[]>();
  const unplaced: T[] = [];
  for (const diagnostic of diagnostics) {
    const path = fieldPath(diagnostic.path);
    const node =
      path === undefined
        ? undefined
        : paths.find((candidate) => leadsTo(candidate, path));
    if (node === undefined) {
      unplaced.push(diagnostic);
      continue;
    }
    const key = pathKey(node);
    placed.set(key, [...(placed.get(key) ?? []), diagnostic]);
  }
  return {
    at(path) {
      const nodePath = fieldPath(path);
      return nodePath === undefined
        ? []
        : (placed.get(pathKey(nodePath)) ?? []);
    },
    unplaced,
  };
}

const nothingPlaced: DiagnosticPlacement<Diagnostic> = {
  at: () => [],
  unplaced: [],
};

const PlacementContext = createContext<
  Accessor<DiagnosticPlacement<Diagnostic>>
>(() => nothingPlaced);

/** Supplies the findings placed beside each node of a rendered document. */
export const DiagnosticPlacementProvider = PlacementContext.Provider;

/**
 * Shows the findings placed beside the node at a path.
 * @returns The findings, or nothing when there are none.
 */
export function NodeDiagnostics(props: { path: unknown }) {
  const placement = useContext(PlacementContext);
  return <DiagnosticList diagnostics={placement().at(props.path)} />;
}

/**
 * Lists findings of the document validator with their source paths.
 * @returns The list, or nothing when there are none.
 */
export function DiagnosticList(props: { diagnostics: readonly Diagnostic[] }) {
  return (
    <Show when={props.diagnostics.length > 0}>
      <ul class={styles.diagnostics} aria-label="Validator findings">
        <For each={props.diagnostics}>
          {(diagnostic) => (
            <li
              class={
                diagnostic.severity === "error"
                  ? styles.diagnosticError
                  : styles.diagnosticWarning
              }
            >
              <p class={styles.diagnosticHead}>
                <strong>{diagnostic.severity}</strong>
                <span>{diagnostic.category}</span>
                <code>{diagnostic.reason}</code>
                <code class={styles.path}>
                  {JSON.stringify(diagnostic.path)}
                </code>
              </p>
              <p>{diagnostic.message}</p>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
