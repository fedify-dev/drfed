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

import { graphql } from "relay-runtime";
import { For, Match, Show, Switch, createMemo } from "solid-js";
import { createFragment } from "solid-relay";

import { pathKey, toPath, typeLabel } from "~/resource.ts";

import type { ResourceRevision_revision$key } from "./__generated__/ResourceRevision_revision.graphql.ts";
import {
  type Diagnostic,
  DiagnosticList,
  DocumentTree,
  JsonDisclosure,
} from "./ResourceDocument.tsx";

import styles from "~/styles/resource.module.css";

/** A node of the document tree, as far as the tree draws nodes. */
interface DrawnNode {
  readonly path: unknown;
  readonly relations?: readonly {
    readonly representation: string;
    readonly node?: DrawnNode | null | undefined;
  }[];
}

/**
 * Collects the paths of the nodes the document tree draws: the root and the
 * embedded documents three levels below it, as far as the fragment selects.
 * @returns The path keys.
 */
const drawnPaths = (node: DrawnNode): readonly string[] => [
  pathKey(toPath(node.path)),
  ...(node.relations ?? []).flatMap((relation) =>
    relation.representation === "embedded" && relation.node != undefined
      ? drawnPaths(relation.node)
      : [],
  ),
];

/**
 * A stored time, written as stored.
 * @returns The time element.
 */
export function TimeText(props: { value: string }) {
  return <time dateTime={props.value}>{props.value}</time>;
}

/**
 * One revision: how DrFed stored it and what it holds.
 * @returns The revision.
 */
export function ResourceRevision(props: {
  $revision: ResourceRevision_revision$key;
  /** Whether it is the current revision of its resource. */
  head: boolean;
}) {
  const data = createFragment(
    graphql`
      fragment ResourceRevision_revision on ResourceRevision
      @throwOnFieldError {
        id
        sequence
        kind
        capture
        backfilled
        created
        deleted
        formerTypes
        interpreted
        document
        diagnostics {
          severity
          category
          reason
          path
          message
        }
        root {
          ...ResourceDocumentLevel0_node
          path
          relations {
            representation
            node {
              path
              relations {
                representation
                node {
                  path
                  relations {
                    representation
                    node {
                      path
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    () => props.$revision,
  );
  const diagnostics = createMemo((): readonly Diagnostic[] =>
    (data()?.diagnostics ?? []).map((diagnostic) => ({
      severity: diagnostic.severity,
      category: diagnostic.category,
      reason: diagnostic.reason,
      path: toPath(diagnostic.path),
      message: diagnostic.message,
    })),
  );
  // Findings of a node the tree draws are shown on that node; the rest below.
  const unplaced = createMemo(() => {
    const root = data()?.root;
    if (root == undefined) return diagnostics();
    const paths = new Set(drawnPaths(root));
    return diagnostics().filter(
      (diagnostic) => !paths.has(pathKey(diagnostic.path)),
    );
  });
  const savedDocument = (): unknown => data()?.document;
  return (
    <Show when={data()}>
      {(revision) => (
        <article class={styles.revision}>
          <header class={styles.revisionHeader}>
            <h2>{props.head ? "Current revision" : "Earlier revision"}</h2>
            <dl class={styles.fields}>
              <div>
                <dt>Sequence</dt>
                <dd>{revision().sequence}</dd>
              </div>
              <div>
                <dt>Kind</dt>
                <dd>{revision().kind}</dd>
              </div>
              <div>
                <dt>Capture</dt>
                <dd>{revision().capture}</dd>
              </div>
              <div>
                <dt>Backfilled</dt>
                <dd>
                  {revision().backfilled
                    ? "Yes, migrated from legacy records"
                    : "No"}
                </dd>
              </div>
              <div>
                <dt>Stored</dt>
                <dd>
                  <TimeText value={revision().created} />
                </dd>
              </div>
              <Show when={revision().deleted}>
                {(deleted) => (
                  <div>
                    <dt>Deleted</dt>
                    <dd>
                      <TimeText value={deleted()} />
                    </dd>
                  </div>
                )}
              </Show>
              <Show when={revision().formerTypes}>
                {(types) => (
                  <div>
                    <dt>Former types</dt>
                    <dd>
                      <For each={types()}>
                        {(type) => <span title={type}>{typeLabel(type)} </span>}
                      </For>
                    </dd>
                  </div>
                )}
              </Show>
            </dl>
          </header>
          <Switch>
            <Match when={revision().kind === "snapshot"}>
              <Show
                when={revision().interpreted ? revision().root : undefined}
                fallback={
                  <p class={styles.notice}>
                    DrFed could not interpret this document, so only its saved
                    JSON is shown. The validator findings below tell why.
                  </p>
                }
              >
                {(root) => (
                  <DocumentTree $root={root()} diagnostics={diagnostics()} />
                )}
              </Show>
              <DiagnosticList diagnostics={unplaced()} />
              {/* Keyed so that each revision's disclosure starts anew. */}
              <Show when={revision().id} keyed>
                <JsonDisclosure
                  value={savedDocument()}
                  label="Saved document (JSON)"
                  open={!revision().interpreted}
                />
              </Show>
            </Match>
            <Match when={revision().kind === "whiteout"}>
              <p class={styles.notice}>
                This revision records a deletion. It holds no document.
              </p>
            </Match>
            <Match when={revision().kind === "unavailable"}>
              <p class={styles.notice}>
                No document was retained for this revision.
              </p>
            </Match>
          </Switch>
        </article>
      )}
    </Show>
  );
}
