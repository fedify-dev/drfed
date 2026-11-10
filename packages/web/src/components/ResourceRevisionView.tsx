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

import { typeLabel } from "~/label.ts";

import type { ResourceRevisionView_revision$key } from "./__generated__/ResourceRevisionView_revision.graphql.ts";
import {
  DiagnosticList,
  DiagnosticPlacementProvider,
  placeDiagnostics,
} from "./DocumentDiagnostics.tsx";
import {
  DocumentNodeView,
  createRenderedNodePaths,
} from "./DocumentNodeView.tsx";
import { JsonDisclosure } from "./JsonDisclosure.tsx";

import styles from "~/styles/resource.module.css";

/**
 * Shows one revision of a resource: how DrFed stored it and what it holds,
 * the saved document read by meaning when the validator reads it, its
 * findings, and the JSON as saved.
 * @returns The revision.
 */
export function ResourceRevisionView(props: {
  $revision: ResourceRevisionView_revision$key;
}) {
  const data = createFragment(
    graphql`
      fragment ResourceRevisionView_revision on ResourceRevision
      @throwOnFieldError {
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
          reason
          category
          severity
          path
          message
        }
        root {
          ...DocumentNodeView_depth1
          ...DocumentNodeView_renderedPaths
        }
      }
    `,
    () => props.$revision,
  );
  const nodePaths = createRenderedNodePaths(() => data()?.root);
  const placement = createMemo(() =>
    placeDiagnostics(nodePaths(), data()?.diagnostics ?? []),
  );
  return (
    <Show when={data()}>
      {(revision) => (
        <article
          class={styles.revision}
          aria-label={`Revision ${revision().sequence}`}
        >
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
                <time dateTime={revision().created}>{revision().created}</time>
              </dd>
            </div>
            <Show when={revision().deleted}>
              {(deleted) => (
                <div>
                  <dt>Deleted</dt>
                  <dd>
                    <time dateTime={deleted()}>{deleted()}</time>
                  </dd>
                </div>
              )}
            </Show>
            <Show when={revision().formerTypes}>
              {(types) => (
                <div>
                  <dt>Former types</dt>
                  <dd>
                    <ul class={styles.typeList}>
                      <For each={types()}>
                        {(type) => <li title={type}>{typeLabel(type)}</li>}
                      </For>
                    </ul>
                  </dd>
                </div>
              )}
            </Show>
          </dl>
          <Switch>
            <Match when={revision().kind === "snapshot"}>
              <Show
                when={revision().interpreted ? revision().root : undefined}
                fallback={
                  <p class={styles.notice}>
                    DrFed could not interpret this document, so only its saved
                    JSON is shown. The validator findings below tell why.
                    Interpretation does not cover every ActivityStreams property
                    yet; see{" "}
                    <a href="https://github.com/fedify-dev/drfed/issues/168">
                      issue #168
                    </a>
                    .
                  </p>
                }
              >
                {(root) => (
                  <DiagnosticPlacementProvider value={placement}>
                    <DocumentNodeView
                      $node={root()}
                      revisionCreated={revision().created}
                    />
                  </DiagnosticPlacementProvider>
                )}
              </Show>
              <DiagnosticList diagnostics={placement().unplaced} />
              <JsonDisclosure
                value={revision().document}
                label="Saved document (JSON)"
              />
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
