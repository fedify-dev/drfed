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

// The document tree of a revision: the root and the documents embedded in it,
// three levels deep.  Relay fragments cannot recurse, so each level has its
// own fragment that spreads the next one.

import { A } from "@solidjs/router";
import { graphql } from "relay-runtime";
import {
  For,
  type JSX,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
} from "solid-js";
import { createFragment } from "solid-relay";

import {
  type Path,
  WORDING,
  formatPointer,
  pathKey,
  resourceHref,
  toPath,
  typeLabel,
} from "~/resource.ts";

import type { ResourceDocumentLevel0_node$key } from "./__generated__/ResourceDocumentLevel0_node.graphql.ts";
import type { ResourceDocumentLevel1_node$key } from "./__generated__/ResourceDocumentLevel1_node.graphql.ts";
import type { ResourceDocumentLevel2_node$key } from "./__generated__/ResourceDocumentLevel2_node.graphql.ts";
import type { ResourceDocumentLevel3_node$key } from "./__generated__/ResourceDocumentLevel3_node.graphql.ts";
import type {
  ResourceDocumentParts_node$data,
  ResourceDocumentParts_node$key,
} from "./__generated__/ResourceDocumentParts_node.graphql.ts";
import type { ResourceDocumentRelation_relation$key } from "./__generated__/ResourceDocumentRelation_relation.graphql.ts";
import { ActivityLogSource } from "./ActivityLogSource.tsx";
import { CopyButton } from "./CopyButton.tsx";

import styles from "~/styles/resource.module.css";

const STATUS_LABELS: ReadonlyMap<string, string> = new Map([
  ["current", "Current"],
  ["superseded", "Newer revisions exist"],
  ["deleted", "Deleted"],
]);

/** A validator finding, with its path narrowed. */
export interface Diagnostic {
  readonly severity: string;
  readonly category: string;
  readonly reason: string;
  readonly path: Path;
  readonly message: string;
}

/** A relation value as a level fragment selects it. */
interface LevelRelation {
  readonly property: string;
  readonly representation: string;
  readonly node: unknown;
  readonly " $fragmentSpreads": ResourceDocumentRelation_relation$key[" $fragmentSpreads"];
}

const formatJson = (value: unknown) => JSON.stringify(value, undefined, 2);

const statusLabel = (status: string | null | undefined): string | undefined =>
  status == undefined ? undefined : STATUS_LABELS.get(status);

/**
 * Shows saved JSON in a disclosure, highlighted once opened.
 * @returns The disclosure.
 */
export function JsonDisclosure(props: {
  value: unknown;
  label: string;
  open: boolean;
}) {
  // oxlint-disable-next-line solid/reactivity -- Only the initial state.
  const [open, setOpen] = createSignal(props.open);
  return (
    <details
      class={styles.json}
      open={open()}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{props.label}</summary>
      <Show when={open()}>
        <CopyButton value={formatJson(props.value)} label={props.label} />
        <ActivityLogSource source={formatJson(props.value)} json />
      </Show>
    </details>
  );
}

/**
 * A source path as a JSON Pointer.
 * @returns The pointer, or nothing for the root.
 */
function PathText(props: { path: Path }) {
  return (
    <Show when={formatPointer(props.path)}>
      {(text) => <code class={styles.path}>{text()}</code>}
    </Show>
  );
}

/**
 * Validator findings, with their paths as JSON Pointers.
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
                <PathText path={diagnostic.path} />
              </p>
              <p>{diagnostic.message}</p>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

/**
 * Values grouped by property, in the order the properties first appear.
 * @returns The groups, or nothing when there are none.
 */
function PropertyGroups<T extends { readonly property: string }>(props: {
  label: string;
  entries: readonly T[];
  children: (entry: T) => JSX.Element;
}) {
  const groups = createMemo(() => [
    ...Map.groupBy(props.entries, (entry) => entry.property),
  ]);
  return (
    <Show when={groups().length > 0}>
      <p class={styles.sectionLabel}>{props.label}</p>
      <dl class={styles.groups}>
        <For each={groups()}>
          {([property, entries]) => (
            <div>
              <dt>
                <code>{property}</code>
              </dt>
              <dd>
                <ul class={styles.values}>
                  <For each={entries}>{(entry) => props.children(entry)}</For>
                </ul>
              </dd>
            </div>
          )}
        </For>
      </dl>
    </Show>
  );
}

/**
 * An IRI, linked to the resource registered under it when the viewer may
 * read one.
 * @returns The IRI.
 */
function IriText(props: { iri: string; resourceId: string | undefined }) {
  return (
    <Show when={props.resourceId} fallback={<span>{props.iri}</span>}>
      {(id) => <A href={resourceHref(id())}>{props.iri}</A>}
    </Show>
  );
}

/**
 * The labels of `DocumentNode.source`, or the neutral note when it is null
 * and the viewer may read some revision of the resource under its IRI.
 * @returns The labels, or nothing for an anonymous document or one with no
 *          revision to have come from.
 */
function SourceLabels(props: {
  source:
    | {
        readonly relation: string;
        readonly status: string | null | undefined;
        readonly revision: {
          readonly sequence: number;
          readonly resource: { readonly id: string };
        };
      }
    | null
    | undefined;
  /** Whether the viewer may read a revision it could have come from. */
  expected: boolean;
}) {
  return (
    <Show
      when={props.source}
      fallback={
        <Show when={props.expected}>
          <span class={styles.faint}>Source revision unknown</span>
        </Show>
      }
    >
      {(source) => (
        <span class={styles.labels}>
          <span class={styles.pill}>
            {source().relation === "snapshot" ? "Snapshot" : "Derived"}
          </span>
          <Show
            when={statusLabel(source().status)}
            fallback={<span class={styles.faint}>Unknown</span>}
          >
            {(label) => <span class={styles.pill}>{label()}</span>}
          </Show>
          <A
            class={styles.sourceLink}
            href={resourceHref(
              source().revision.resource.id,
              source().revision.sequence,
            )}
          >
            {WORDING.sourceLink(source().revision.sequence)}
          </A>
          <Show when={source().status === "superseded"}>
            <A
              class={styles.sourceLink}
              href={resourceHref(source().revision.resource.id)}
            >
              {WORDING.currentLink}
            </A>
          </Show>
        </span>
      )}
    </Show>
  );
}

/**
 * A relation value drawn as one line: a reference, a `Link`, or an embedded
 * document that is not expanded.
 * @returns The line.
 */
function RelationLine(props: {
  $relation: ResourceDocumentRelation_relation$key;
}) {
  const data = createFragment(
    graphql`
      fragment ResourceDocumentRelation_relation on DocumentRelation
      @throwOnFieldError {
        representation
        iri
        path
        resource {
          id
        }
      }
    `,
    () => props.$relation,
  );
  return (
    <Show when={data()}>
      {(relation) => (
        <span class={styles.valueLine}>
          <Switch>
            <Match when={relation().representation === "embedded"}>
              <span class={styles.pillEmbedded}>Embedded</span>
              <span class={styles.iri}>
                {relation().iri ?? <span class={styles.faint}>Anonymous</span>}
              </span>
            </Match>
            <Match when={relation().representation === "link"}>
              <span class={styles.pill}>Link</span>
              <span class={styles.iri}>{relation().iri}</span>
            </Match>
            <Match when>
              <span class={styles.pill}>Reference</span>
              <span class={styles.iri}>
                <IriText
                  iri={relation().iri ?? ""}
                  resourceId={relation().resource?.id}
                />
              </span>
              <Show when={relation().resource == undefined}>
                <span class={styles.faint}>{WORDING.unreadableReference}</span>
              </Show>
            </Match>
          </Switch>
          <PathText path={toPath(relation().path)} />
        </span>
      )}
    </Show>
  );
}

function PollFields(props: {
  poll: NonNullable<ResourceDocumentParts_node$data["poll"]>;
}) {
  return (
    <>
      <p class={styles.sectionLabel}>Poll</p>
      <dl class={styles.groups}>
        <div>
          <dt>Choices</dt>
          <dd>
            <Switch>
              <Match when={props.poll.mode === "exclusive"}>
                Single-choice poll
              </Match>
              <Match when={props.poll.mode === "inclusive"}>
                Multiple-choice poll
              </Match>
            </Switch>
            <Show
              when={props.poll.choices.length > 0}
              fallback={<span class={styles.faint}>No choices supplied</span>}
            >
              <ol class={styles.pollChoices}>
                <For each={props.poll.choices}>
                  {(choice) => (
                    <li class={styles.value}>
                      <span class={styles.valueLine}>
                        <Show when={choice.iri}>
                          {(iri) => <span class={styles.iri}>{iri()}</span>}
                        </Show>
                        <PathText path={toPath(choice.path)} />
                      </span>
                      <Show when={choice.node}>
                        {(node) => {
                          const document = (): unknown => node().document;
                          return (
                            <JsonDisclosure
                              value={document()}
                              label={`Saved choice (${typeLabel(node().type)})`}
                              open={false}
                            />
                          );
                        }}
                      </Show>
                    </li>
                  )}
                </For>
              </ol>
            </Show>
          </dd>
        </div>
        <div>
          <dt>
            <code>closed</code>
          </dt>
          <dd>
            <Switch fallback={<span class={styles.faint}>Not set</span>}>
              <Match when={props.poll.closedAt}>
                {(instant) => <time dateTime={instant()}>{instant()}</time>}
              </Match>
              <Match when={typeof props.poll.closed === "boolean"}>
                <code>{String(props.poll.closed)}</code>
              </Match>
            </Switch>
          </dd>
        </div>
      </dl>
    </>
  );
}

/**
 * One document node: its header line and what it holds below it.  The root
 * stands alone; an embedded document is a disclosure joined to its parent by
 * a guide line.
 * @returns The node.
 */
function NodeView<T extends LevelRelation>(props: {
  $node: ResourceDocumentParts_node$key;
  depth: number;
  relations: readonly T[];
  diagnostics: readonly Diagnostic[];
  /** Whether a source could have been recorded; see `SourceLabels`. */
  sourceExpected: boolean;
  /** Draws the document an embedded value holds. */
  embedded: (node: NonNullable<T["node"]>, relation: T) => JSX.Element;
}) {
  const data = createFragment(
    graphql`
      fragment ResourceDocumentParts_node on DocumentNode @throwOnFieldError {
        type
        kind
        iri
        path
        poll {
          mode
          closed
          closedAt
          choices {
            path
            iri
            node {
              type
              document
            }
          }
        }
        addressing {
          property
          position
          iri
          resource {
            id
          }
        }
        extensions {
          key
          value
        }
        source {
          relation
          status
          revision {
            sequence
            resource {
              id
            }
          }
        }
      }
    `,
    () => props.$node,
  );
  return (
    <Show when={data()}>
      {(node) => {
        const path = () => toPath(node().path);
        const header = () => (
          <span class={styles.nodeHeader}>
            <Show when={props.depth > 0}>
              <span class={styles.pillEmbedded}>Embedded</span>
            </Show>
            <span class={styles.nodeType} title={node().type}>
              {typeLabel(node().type)}
            </span>
            <span class={styles.pill}>{node().kind}</span>
            <span class={styles.iri}>
              {node().iri ?? <span class={styles.faint}>Anonymous</span>}
            </span>
            <PathText path={path()} />
          </span>
        );
        // The source links stay out of the summary, which must hold no
        // interactive element of its own.
        const body = () => (
          <div class={styles.nodeBody}>
            <Show when={props.depth > 0}>
              <p class={styles.sourceRow}>
                <SourceLabels
                  source={node().source}
                  expected={props.sourceExpected}
                />
              </p>
            </Show>
            <DiagnosticList
              diagnostics={props.diagnostics.filter(
                (diagnostic) => pathKey(diagnostic.path) === pathKey(path()),
              )}
            />
            <Show when={node().poll}>
              {(poll) => <PollFields poll={poll()} />}
            </Show>
            <PropertyGroups label="Relations" entries={props.relations}>
              {(relation) => (
                <li class={styles.value}>
                  <Show
                    when={
                      relation.representation === "embedded"
                        ? relation.node
                        : undefined
                    }
                    fallback={<RelationLine $relation={relation} />}
                  >
                    {(child) => props.embedded(child(), relation)}
                  </Show>
                </li>
              )}
            </PropertyGroups>
            <PropertyGroups label="Addressing" entries={node().addressing}>
              {(recipient) => (
                <li class={styles.value}>
                  <span class={styles.valueLine}>
                    <span class={styles.position}>[{recipient.position}]</span>
                    <span class={styles.iri}>
                      <Show
                        when={recipient.iri}
                        fallback={<span class={styles.faint}>Anonymous</span>}
                      >
                        {(iri) => (
                          <IriText
                            iri={iri()}
                            resourceId={recipient.resource?.id}
                          />
                        )}
                      </Show>
                    </span>
                  </span>
                </li>
              )}
            </PropertyGroups>
            <Show when={node().extensions.length > 0}>
              <p class={styles.sectionLabel}>Extension properties</p>
              <dl class={styles.groups}>
                <For each={node().extensions}>
                  {(extension) => (
                    <div>
                      <dt>
                        <code>{extension.key}</code>
                      </dt>
                      <dd>
                        <pre class={styles.extensionValue}>
                          <code>{formatJson(extension.value)}</code>
                        </pre>
                      </dd>
                    </div>
                  )}
                </For>
              </dl>
            </Show>
          </div>
        );
        return (
          <Show
            when={props.depth > 0}
            fallback={
              <div class={styles.rootNode}>
                {header()}
                {body()}
              </div>
            }
          >
            <details class={styles.embedded} open>
              <summary class={styles.nodeSummary}>{header()}</summary>
              {body()}
            </details>
          </Show>
        );
      }}
    </Show>
  );
}

/**
 * A document three levels below the root, whose embedded documents are shown
 * as saved JSON.
 * @returns The node.
 */
function Level3(props: {
  $node: ResourceDocumentLevel3_node$key;
  diagnostics: readonly Diagnostic[];
  sourceExpected: boolean;
}) {
  const data = createFragment(
    graphql`
      fragment ResourceDocumentLevel3_node on DocumentNode @throwOnFieldError {
        ...ResourceDocumentParts_node
        relations {
          property
          representation
          ...ResourceDocumentRelation_relation
          node {
            document
          }
        }
      }
    `,
    () => props.$node,
  );
  return (
    <Show when={data()}>
      {(node) => (
        <NodeView
          $node={node()}
          depth={3}
          relations={node().relations}
          diagnostics={props.diagnostics}
          sourceExpected={props.sourceExpected}
          embedded={(child, relation) => {
            const document: unknown = child.document;
            return (
              <>
                <RelationLine $relation={relation} />
                <JsonDisclosure
                  value={document}
                  label="Embedded document (JSON, not expanded further)"
                  open
                />
              </>
            );
          }}
        />
      )}
    </Show>
  );
}

/**
 * A document two levels below the root.
 * @returns The node.
 */
function Level2(props: {
  $node: ResourceDocumentLevel2_node$key;
  diagnostics: readonly Diagnostic[];
  sourceExpected: boolean;
}) {
  const data = createFragment(
    graphql`
      fragment ResourceDocumentLevel2_node on DocumentNode @throwOnFieldError {
        ...ResourceDocumentParts_node
        relations {
          property
          representation
          ...ResourceDocumentRelation_relation
          resource {
            revisions(first: 1) {
              edges {
                cursor
              }
            }
          }
          node {
            ...ResourceDocumentLevel3_node
          }
        }
      }
    `,
    () => props.$node,
  );
  return (
    <Show when={data()}>
      {(node) => (
        <NodeView
          $node={node()}
          depth={2}
          relations={node().relations}
          diagnostics={props.diagnostics}
          sourceExpected={props.sourceExpected}
          embedded={(child, relation) => (
            <Level3
              $node={child}
              diagnostics={props.diagnostics}
              sourceExpected={
                (relation.resource?.revisions.edges.length ?? 0) > 0
              }
            />
          )}
        />
      )}
    </Show>
  );
}

/**
 * A document one level below the root.
 * @returns The node.
 */
function Level1(props: {
  $node: ResourceDocumentLevel1_node$key;
  diagnostics: readonly Diagnostic[];
  sourceExpected: boolean;
}) {
  const data = createFragment(
    graphql`
      fragment ResourceDocumentLevel1_node on DocumentNode @throwOnFieldError {
        ...ResourceDocumentParts_node
        relations {
          property
          representation
          ...ResourceDocumentRelation_relation
          resource {
            revisions(first: 1) {
              edges {
                cursor
              }
            }
          }
          node {
            ...ResourceDocumentLevel2_node
          }
        }
      }
    `,
    () => props.$node,
  );
  return (
    <Show when={data()}>
      {(node) => (
        <NodeView
          $node={node()}
          depth={1}
          relations={node().relations}
          diagnostics={props.diagnostics}
          sourceExpected={props.sourceExpected}
          embedded={(child, relation) => (
            <Level2
              $node={child}
              diagnostics={props.diagnostics}
              sourceExpected={
                (relation.resource?.revisions.edges.length ?? 0) > 0
              }
            />
          )}
        />
      )}
    </Show>
  );
}

/**
 * The root document of a revision and what it embeds.
 * @returns The document tree.
 */
export function DocumentTree(props: {
  $root: ResourceDocumentLevel0_node$key;
  diagnostics: readonly Diagnostic[];
}) {
  const data = createFragment(
    graphql`
      fragment ResourceDocumentLevel0_node on DocumentNode @throwOnFieldError {
        ...ResourceDocumentParts_node
        relations {
          property
          representation
          ...ResourceDocumentRelation_relation
          resource {
            revisions(first: 1) {
              edges {
                cursor
              }
            }
          }
          node {
            ...ResourceDocumentLevel1_node
          }
        }
      }
    `,
    () => props.$root,
  );
  return (
    <Show when={data()}>
      {(node) => (
        <NodeView
          $node={node()}
          depth={0}
          relations={node().relations}
          diagnostics={props.diagnostics}
          sourceExpected={false}
          embedded={(child, relation) => (
            <Level1
              $node={child}
              diagnostics={props.diagnostics}
              sourceExpected={
                (relation.resource?.revisions.edges.length ?? 0) > 0
              }
            />
          )}
        />
      )}
    </Show>
  );
}
