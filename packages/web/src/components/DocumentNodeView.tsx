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

// A document is shown by what `DocumentNode` says it means, never by the
// keys of its JSON, which aliases and contexts may spell otherwise.  Relay
// rejects a fragment that spreads itself, so each depth has its own
// fragment: the root, the documents it embeds, and those they embed, which
// covers `Undo(Like(Note))` and `Create(Note)`.  What the third depth embeds
// is shown as JSON.  `DocumentNodeView_renderedPaths` follows the same
// depths.

import { graphql } from "relay-runtime";
import {
  type Accessor,
  For,
  type JSX,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
} from "solid-js";
import { createFragment } from "solid-relay";

import { compareDateTimes } from "~/instant.ts";
import { typeLabel } from "~/label.ts";

import type { DocumentNodeView_depth1$key } from "./__generated__/DocumentNodeView_depth1.graphql.ts";
import type { DocumentNodeView_depth2$key } from "./__generated__/DocumentNodeView_depth2.graphql.ts";
import type { DocumentNodeView_depth3$key } from "./__generated__/DocumentNodeView_depth3.graphql.ts";
import type { DocumentNodeView_relation$key } from "./__generated__/DocumentNodeView_relation.graphql.ts";
import type { DocumentNodeView_renderedPaths$key } from "./__generated__/DocumentNodeView_renderedPaths.graphql.ts";
import type { DocumentNodeView_summary$key } from "./__generated__/DocumentNodeView_summary.graphql.ts";
import { ActivityLogSource } from "./ActivityLogSource.tsx";
import { NodeDiagnostics } from "./DocumentDiagnostics.tsx";
import { JsonDisclosure, formatJson } from "./JsonDisclosure.tsx";
import { ResourceLink } from "./ResourceLink.tsx";

import styles from "~/styles/resource.module.css";

/**
 * Shows a document of a saved revision by meaning: its type, its own IRI
 * and source path, its relations grouped by property, its recipients and
 * its extension properties, with the documents it embeds three levels deep.
 * @returns The document, the root of the tree.
 */
export function DocumentNodeView(props: {
  $node: DocumentNodeView_depth1$key;
  /**
   * When the revision holding the document was stored, which tells whether
   * what it embeds has changed since.
   */
  revisionCreated: string;
}) {
  const data = createFragment(
    graphql`
      fragment DocumentNodeView_depth1 on DocumentNode @throwOnFieldError {
        ...DocumentNodeView_summary
        relations {
          property
          ...DocumentNodeView_relation
          node {
            ...DocumentNodeView_depth2
          }
        }
      }
    `,
    () => props.$node,
  );
  return (
    <Show when={data()}>
      {(node) => (
        <NodeFrame $node={node()}>
          <PropertyGroups label="Relations" entries={node().relations}>
            {(relation) => (
              <RelationEntry
                $relation={relation}
                revisionCreated={props.revisionCreated}
              >
                <Show when={relation.node}>
                  {(child) => (
                    <SecondDepthNode
                      $node={child()}
                      revisionCreated={props.revisionCreated}
                    />
                  )}
                </Show>
              </RelationEntry>
            )}
          </PropertyGroups>
        </NodeFrame>
      )}
    </Show>
  );
}

function SecondDepthNode(props: {
  $node: DocumentNodeView_depth2$key;
  revisionCreated: string;
}) {
  const data = createFragment(
    graphql`
      fragment DocumentNodeView_depth2 on DocumentNode @throwOnFieldError {
        ...DocumentNodeView_summary
        relations {
          property
          ...DocumentNodeView_relation
          node {
            ...DocumentNodeView_depth3
          }
        }
      }
    `,
    () => props.$node,
  );
  return (
    <Show when={data()}>
      {(node) => (
        <NodeFrame $node={node()}>
          <PropertyGroups label="Relations" entries={node().relations}>
            {(relation) => (
              <RelationEntry
                $relation={relation}
                revisionCreated={props.revisionCreated}
              >
                <Show when={relation.node}>
                  {(child) => (
                    <ThirdDepthNode
                      $node={child()}
                      revisionCreated={props.revisionCreated}
                    />
                  )}
                </Show>
              </RelationEntry>
            )}
          </PropertyGroups>
        </NodeFrame>
      )}
    </Show>
  );
}

function ThirdDepthNode(props: {
  $node: DocumentNodeView_depth3$key;
  revisionCreated: string;
}) {
  const data = createFragment(
    graphql`
      fragment DocumentNodeView_depth3 on DocumentNode @throwOnFieldError {
        ...DocumentNodeView_summary
        relations {
          property
          ...DocumentNodeView_relation
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
        <NodeFrame $node={node()}>
          <PropertyGroups label="Relations" entries={node().relations}>
            {(relation) => (
              <RelationEntry
                $relation={relation}
                revisionCreated={props.revisionCreated}
              >
                <Show when={relation.node}>
                  {(child) => (
                    <JsonDisclosure
                      value={child().document}
                      label="Embedded document (JSON, not expanded further)"
                      open
                    />
                  )}
                </Show>
              </RelationEntry>
            )}
          </PropertyGroups>
        </NodeFrame>
      )}
    </Show>
  );
}

/**
 * Reads the source paths of the documents {@link DocumentNodeView} renders
 * from the same root, so that validator findings can be placed beside them.
 * @returns The paths, the root's first.
 */
export function createRenderedNodePaths(
  node: Accessor<DocumentNodeView_renderedPaths$key | null | undefined>,
): Accessor<readonly unknown[]> {
  const data = createFragment(
    graphql`
      fragment DocumentNodeView_renderedPaths on DocumentNode
      @throwOnFieldError {
        path
        relations {
          node {
            path
            relations {
              node {
                path
              }
            }
          }
        }
      }
    `,
    node,
  );
  const paths = createMemo((): readonly unknown[] => {
    const root = data();
    if (root == undefined) return [];
    const second = root.relations.flatMap(({ node: child }) =>
      child == undefined ? [] : [child],
    );
    const third = second.flatMap(({ relations }) =>
      relations.flatMap(({ node: child }) =>
        child == undefined ? [] : [child],
      ),
    );
    return [root, ...second, ...third].map(({ path }) => path);
  });
  return paths;
}

/**
 * The parts every depth shows of a document: its type and identity, the
 * findings placed beside it, its recipients and extension properties.
 * @returns The document's frame around its relations.
 */
function NodeFrame(props: {
  $node: DocumentNodeView_summary$key;
  /** Its relations. */
  children: JSX.Element;
}) {
  const data = createFragment(
    graphql`
      fragment DocumentNodeView_summary on DocumentNode @throwOnFieldError {
        path
        type
        kind
        iri
        addressing {
          property
          position
          representation
          iri
          resource {
            id
          }
        }
        extensions {
          key
          value
        }
      }
    `,
    () => props.$node,
  );
  return (
    <Show when={data()}>
      {(node) => (
        <article class={styles.node}>
          <header class={styles.nodeHeader}>
            <span class={styles.nodeType} title={node().type}>
              {typeLabel(node().type)}
            </span>
            <span class={styles.badge}>{node().kind}</span>
          </header>
          <dl class={styles.nodeFields}>
            <div>
              <dt>{node().kind === "link" ? "href" : "IRI"}</dt>
              <dd>
                {node().iri ?? (
                  <span class={styles.missing}>None (anonymous)</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Path</dt>
              <dd>{JSON.stringify(node().path)}</dd>
            </div>
          </dl>
          <NodeDiagnostics path={node().path} />
          {props.children}
          <PropertyGroups label="Addressing" entries={node().addressing}>
            {(recipient) => (
              <li class={styles.entry}>
                <p class={styles.entryHead}>
                  <span>[{recipient.position}]</span>
                  <Show when={recipient.representation !== "reference"}>
                    <span class={styles.badge}>
                      {representationLabels[recipient.representation] ??
                        recipient.representation}
                    </span>
                  </Show>
                  <Show
                    when={recipient.iri}
                    fallback={
                      <span class={styles.missing}>
                        Anonymous embedded recipient
                      </span>
                    }
                  >
                    {(iri) => (
                      <Show when={recipient.resource} fallback={iri()}>
                        {(resource) => (
                          <ResourceLink id={resource().id}>
                            {iri()}
                          </ResourceLink>
                        )}
                      </Show>
                    )}
                  </Show>
                </p>
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
        </article>
      )}
    </Show>
  );
}

const representationLabels: Readonly<Record<string, string>> = {
  reference: "Reference",
  embedded: "Embedded",
  link: "Link",
};

/**
 * Lists values grouped by their property, in the order the properties first
 * appear.
 * @returns The groups, or nothing when there are no values.
 */
function PropertyGroups<T extends { readonly property: string }>(props: {
  label: string;
  entries: readonly T[];
  /** Renders one value as a list item. */
  children: (entry: T) => JSX.Element;
}) {
  const groups = createMemo(() => {
    const byProperty = new Map<string, T[]>();
    for (const entry of props.entries) {
      byProperty.set(entry.property, [
        ...(byProperty.get(entry.property) ?? []),
        entry,
      ]);
    }
    return [...byProperty];
  });
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
 * One value of a relation: a reference by IRI, an embedded document, or an
 * embedded `Link`, with the resource registered under its IRI.
 * @returns The value as a list item.
 */
function RelationEntry(props: {
  $relation: DocumentNodeView_relation$key;
  /** When the revision holding the relation was stored. */
  revisionCreated: string;
  /** What an embedded document or `Link` holds. */
  children: JSX.Element;
}) {
  const data = createFragment(
    graphql`
      fragment DocumentNodeView_relation on DocumentRelation
      @throwOnFieldError {
        representation
        iri
        path
        node {
          document
        }
        resource {
          id
          currentRevision {
            sequence
            kind
            created
            document
          }
        }
      }
    `,
    () => props.$relation,
  );
  return (
    <Show when={data()}>
      {(relation) => (
        <li class={styles.entry}>
          <p class={styles.entryHead}>
            <span class={styles.badge}>
              {representationLabels[relation().representation] ??
                relation().representation}
            </span>
            <Switch>
              <Match when={relation().representation === "embedded"}>
                {relation().iri ?? (
                  <span class={styles.missing}>Anonymous</span>
                )}
                <Show when={relation().resource}>
                  {(resource) => (
                    <ResourceLink id={resource().id}>
                      Current state
                    </ResourceLink>
                  )}
                </Show>
              </Match>
              <Match when={relation().resource}>
                {(resource) => (
                  <ResourceLink id={resource().id}>
                    {relation().iri}
                  </ResourceLink>
                )}
              </Match>
              <Match when={relation().representation === "reference"}>
                {relation().iri}
                <span class={styles.missing}>
                  Not registered or not readable
                </span>
              </Match>
              <Match when>{relation().iri}</Match>
            </Switch>
            <span class={styles.path}>{JSON.stringify(relation().path)}</span>
          </p>
          {props.children}
          <Show
            when={
              relation().representation === "embedded"
                ? relation().resource?.currentRevision
                : undefined
            }
          >
            {(current) => (
              <CurrentComparison
                saved={relation().node?.document}
                revisionCreated={props.revisionCreated}
                current={current()}
              />
            )}
          </Show>
        </li>
      )}
    </Show>
  );
}

interface CurrentRevision {
  readonly sequence: number;
  readonly kind: string;
  readonly created: string;
  readonly document: unknown;
}

/**
 * What the current revision of an embedded resource is to the revision
 * that embeds it.  A write saves all its revisions in one transaction, so
 * they share their `created` time, and a later write's are later.
 */
const currentStates = {
  saved: {
    label: "Saved with this revision",
    description:
      "The write that stored this revision also stored the current " +
      "revision of the resource, which has not changed since.",
    changed: false,
  },
  changed: {
    label: "Changed after this revision",
    description:
      "The resource has a revision stored after this one, so its current " +
      "state may differ from the copy embedded here.",
    changed: true,
  },
  deleted: {
    label: "Deleted after this revision",
    description: "The resource was deleted after this revision was stored.",
    changed: true,
  },
  copy: {
    label: "Embedded copy",
    description:
      "The current revision of the resource is older than this revision, " +
      "so the copy embedded here was never saved as a revision of the " +
      "resource.  It may or may not match the current revision.",
    changed: false,
  },
} as const;

/**
 * Tells what the current revision of an embedded resource is to the
 * revision that embeds it, by their `created` times at full precision.
 * @returns The state, or `undefined` when a time cannot be compared.
 */
function currentState(
  revisionCreated: string,
  current: CurrentRevision,
): keyof typeof currentStates | undefined {
  const order = compareDateTimes(current.created, revisionCreated);
  if (order === undefined) return undefined;
  if (order === 0) return "saved";
  if (order < 0) return "copy";
  return current.kind === "whiteout" ? "deleted" : "changed";
}

/**
 * Shows an embedded document as saved beside the current revision of the
 * resource registered under its IRI, and whether that changed since.
 * @returns A disclosure with both side by side.
 */
function CurrentComparison(props: {
  saved: unknown;
  /** When the revision embedding the document was stored. */
  revisionCreated: string;
  current: CurrentRevision;
}) {
  const [open, setOpen] = createSignal(false);
  const state = createMemo(() => {
    const key = currentState(props.revisionCreated, props.current);
    return key === undefined ? undefined : currentStates[key];
  });
  return (
    <details
      class={styles.comparison}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        Compare with the current revision (#{props.current.sequence})
        <Show when={state()}>
          {(value) => (
            <>
              {" "}
              <span
                class={value().changed ? styles.badgeStrong : styles.badge}
                title={value().description}
              >
                {value().label}
              </span>
            </>
          )}
        </Show>
      </summary>
      <Show when={open()}>
        <Show when={state()}>
          {(value) => <p class={styles.empty}>{value().description}</p>}
        </Show>
        <div class={styles.comparisonColumns}>
          <section aria-label="As embedded here">
            <p class={styles.sectionLabel}>As embedded here</p>
            <ActivityLogSource source={formatJson(props.saved)} json />
          </section>
          <section aria-label="Current revision">
            <p class={styles.sectionLabel}>
              Current revision #{props.current.sequence},{" "}
              <time dateTime={props.current.created}>
                {props.current.created}
              </time>
            </p>
            <Switch>
              <Match when={props.current.kind === "snapshot"}>
                <ActivityLogSource
                  source={formatJson(props.current.document)}
                  json
                />
              </Match>
              <Match when={props.current.kind === "whiteout"}>
                <p class={styles.empty}>
                  Deleted. The current revision holds no document.
                </p>
              </Match>
              <Match when>
                <p class={styles.empty}>
                  No document was retained for the current revision.
                </p>
              </Match>
            </Switch>
          </section>
        </div>
      </Show>
    </details>
  );
}
