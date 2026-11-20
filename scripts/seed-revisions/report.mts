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

// Keep the viewers' requests in a fixed order.
// oxlint-disable no-await-in-loop

import type { SeededCase } from "./case.mts";
import { type GraphqlRequest, type Member, globalId } from "./environment.mts";

const NODE = "type iri source { relation status revision { sequence } }";
const RELATION =
  "path representation resource { currentRevision { sequence } }";
const QUERY = `query($id: ID!) { node(id: $id) { ... on Resource {
  iri kind
  currentRevision { sequence kind capture interpreted root {
    ${NODE} relations { ${RELATION} node {
      ${NODE} relations { ${RELATION} node {
        ${NODE}
      } }
    } }
  } }
  revisions(first: 50) { edges { node { sequence kind capture } } }
} } }`;

/** Who reads the seeded data, by a label for the report. */
export interface Viewer {
  readonly label: string;
  readonly member: Member | null;
}

interface NodeView {
  readonly type: string | null;
  readonly iri: string | null;
  readonly source: {
    readonly relation: string;
    readonly status: string | null;
    readonly revision: { readonly sequence: number };
  } | null;
  readonly relations?: readonly {
    readonly path: readonly (string | number)[];
    readonly representation: string;
    readonly resource: {
      readonly currentRevision: { readonly sequence: number } | null;
    } | null;
    readonly node: NodeView | null;
  }[];
}

type Relation = NonNullable<NodeView["relations"]>[number];

/**
 * How a client may present where an embedded document came from, told from
 * fields a reader already has:
 *
 *  -  `recorded`: the revision recorded its source.
 *  -  `anonymous`: the document has no `id`, so it can have no source, and
 *     nothing needs to be shown.
 *  -  `no-revisions`: no revision of the resource under its `id` is readable
 *     by the viewer, usually because none exists, as for a collection, so
 *     there was nothing to compare it with.
 *  -  `unrecorded`: the resource has revisions, but none was recorded as the
 *     source.  The document may still equal one of them; this is not a
 *     warning.
 */
export type SourceDisplay =
  | "recorded"
  | "anonymous"
  | "no-revisions"
  | "unrecorded";

/**
 * Classifies an embedded document by {@link SourceDisplay}.
 * @returns The class.
 */
export function sourceDisplay({ node, resource }: Relation): SourceDisplay {
  if (node?.source != null) return "recorded";
  if (node?.iri == null) return "anonymous";
  return resource?.currentRevision == null ? "no-revisions" : "unrecorded";
}

const shortType = (type: string | null): string =>
  type?.split("#").at(-1) ?? "?";

/**
 * Lists the embedded documents under a node with their sources.
 * @returns One line per embedded document, parents first.
 */
function embeddedSources(parent: NodeView): string[] {
  return (parent.relations ?? []).flatMap((relation) => {
    const { path, representation, node } = relation;
    if (representation !== "embedded" || node == null) return [];
    const { source } = node;
    const described =
      source == null
        ? `no source (${sourceDisplay(relation)})`
        : `${source.relation} of #${source.revision.sequence}, status ${source.status ?? "null"}`;
    return [
      `${path.join(".")} (${shortType(node.type)}): ${described}`,
      ...embeddedSources(node),
    ];
  });
}

// oxlint-disable-next-line typescript/no-explicit-any
function describe(node: Record<string, any> | null | undefined): string[] {
  if (node == null || node.kind == null) return ["resource: null"];
  const revisions = (
    node.revisions.edges as { node: { sequence: number; kind: string } }[]
  ).map(({ node: { sequence, kind } }) =>
    kind === "snapshot" ? `#${sequence}` : `#${sequence} ${kind}`,
  );
  const current = node.currentRevision;
  const uninterpreted =
    current?.kind === "snapshot" && !current.interpreted
      ? " (not interpreted)"
      : "";
  const head =
    current == null
      ? "null"
      : `#${current.sequence} ${current.kind} ${current.capture}${uninterpreted}`;
  const lines = [
    `kind ${node.kind}; revisions [${revisions.join(", ")}]; current ${head}`,
  ];
  const root = current?.root as NodeView | null | undefined;
  return root == null ? lines : [...lines, ...embeddedSources(root)];
}

/**
 * Reads every seeded resource as every viewer through GraphQL.
 * @returns The report as text lines.
 */
export async function reportCases(
  graphql: GraphqlRequest,
  viewers: readonly Viewer[],
  cases: readonly SeededCase[],
): Promise<string[]> {
  const lines: string[] = [];
  for (const { number, title, resources } of cases) {
    lines.push("", `## ${number}. ${title}`);
    for (const { label, id, iri } of resources) {
      lines.push("", `${label}: ${globalId("Resource", id)}`);
      if (iri !== "") lines.push(`  ${iri}`);
      for (const viewer of viewers) {
        const body = await graphql(viewer.member, QUERY, {
          id: globalId("Resource", id),
        });
        const described =
          body.errors == null
            ? describe(body.data?.node)
            : [`errors: ${JSON.stringify(body.errors)}`];
        lines.push(
          ...described.map(
            (line, index) =>
              `  ${index === 0 ? viewer.label.padEnd(10) : " ".repeat(10)} ${line}`,
          ),
        );
      }
    }
  }
  return lines;
}
