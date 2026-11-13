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

import { type Database, type Transaction, schema } from "@drfed/models";
import type {
  DocumentNode,
  FieldPath,
  JsonValue,
} from "@drfed/models/document";
import type { RevisionEmbeddingInput } from "@drfed/models/resource-revision";
import type { Uuid } from "@drfed/models/uuid";
import { and, eq, inArray } from "drizzle-orm";

import {
  type InterpretedNode,
  interpretDocument,
} from "../document/interpret.ts";
import { effectiveContext, pathKey } from "./context.ts";
import {
  type EmbeddedSource,
  type JsonObject,
  type LocalWriteError,
  type PreparedResource,
  writeError,
} from "./types.ts";

const ROOT_PATHS: ReadonlySet<string> = new Set([pathKey([])]);

/** A stored revision an embedded document may come from. */
export interface SourceRevision {
  /** The IRI of the resource the revision belongs to. */
  readonly iri: string;
  readonly kind: "snapshot" | "unavailable" | "whiteout";
}

/** A stored snapshot an embedding names, with its document to compare. */
export interface SourceSnapshot {
  readonly revisionId: Uuid;
  readonly document: JsonValue;
}

/**
 * Loads the revisions that requests name as sources, with the IRIs of their
 * resources.
 * @returns The revisions by their lowercase IDs; unknown IDs are absent.
 */
export async function loadSourceRevisions(
  db: Database | Transaction,
  ids: readonly Uuid[],
): Promise<ReadonlyMap<string, SourceRevision>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: schema.resourceRevisions.id,
      kind: schema.resourceRevisions.kind,
      iri: schema.resources.iri,
    })
    .from(schema.resourceRevisions)
    .innerJoin(
      schema.resources,
      eq(schema.resources.id, schema.resourceRevisions.resourceId),
    )
    .where(inArray(schema.resourceRevisions.id, [...new Set(ids)]));
  return new Map(
    rows.map(({ id, kind, iri }) => [id.toLowerCase(), { iri, kind }]),
  );
}

/**
 * Checks the sources a request declares against the submitted document:
 * each names, once, an embedded document that is not a `Link`, is not a new
 * resource of the write, and has an `id`, and a stored snapshot of the
 * resource registered under that `id`.
 * @param sources The declared sources.
 * @param nodes The documents the submitted document describes.
 * @param newPaths The keys of the paths of the write's new resources.
 * @param revisions Looks up the declared revisions.
 * @returns Why a declaration is invalid, or null.
 */
export async function checkSources(
  sources: readonly EmbeddedSource[],
  nodes: readonly DocumentNode[],
  newPaths: ReadonlySet<string>,
  revisions: (
    ids: readonly Uuid[],
  ) => Promise<ReadonlyMap<string, SourceRevision>>,
): Promise<LocalWriteError | null> {
  if (sources.length === 0) return null;
  const invalid = (message: string) => writeError("invalid_request", message);
  const byPath = new Map(nodes.map((node) => [pathKey(node.path), node]));
  const seen = new Set<string>();
  const named: { key: string; iri: string; revisionId: Uuid }[] = [];
  for (const { path, revisionId } of sources) {
    const key = pathKey(path);
    if (seen.has(key)) return invalid(`The source of ${key} is listed twice.`);
    seen.add(key);
    const node = byPath.get(key);
    if (node == null || path.length === 0 || node.kind === "link") {
      return invalid(`${key} is not an embedded document.`);
    }
    if (newPaths.has(key)) {
      return invalid(`${key} is a new resource, which has no source.`);
    }
    const iri = node.identifiers.find(({ property }) => property === "id")?.iri;
    if (iri == null) return invalid(`${key} has no id to name its source.`);
    named.push({ key, iri, revisionId });
  }
  const found = await revisions(named.map(({ revisionId }) => revisionId));
  for (const { key, iri, revisionId } of named) {
    const revision = found.get(revisionId.toLowerCase());
    if (revision?.kind !== "snapshot" || revision.iri !== iri) {
      return invalid(`The source of ${key} is not a saved version of ${iri}.`);
    }
  }
  return null;
}

/**
 * Compares JSON values by structure: object keys in any order, lists in
 * order.
 * @returns Whether the values are equal.
 */
export function sameJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return false;
  }
  if (Array.isArray(left)) {
    const list = right as readonly JsonValue[];
    return (
      left.length === list.length &&
      left.every((entry, index) => sameJson(entry, list[index]!))
    );
  }
  const own = left as JsonObject;
  const other = right as JsonObject;
  const keys = Object.keys(own);
  return (
    keys.length === Object.keys(other).length &&
    keys.every(
      (key) => Object.hasOwn(other, key) && sameJson(own[key]!, other[key]!),
    )
  );
}

const withoutContext = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const { "@context": _, ...rest } = value as JsonObject;
  return rest;
};

/**
 * Tells how an embedded document relates to a stored snapshot: it keeps the
 * snapshot when it is read with the same context entries and, apart from
 * their own `@context`, its JSON equals the snapshot's.
 * @param document The saved document that embeds it.
 * @param nodePaths The keys of the paths of the documents `document`
 *                  describes.
 * @param path The embedded document's path in `document`.
 * @param value The embedded document.
 * @param source The snapshot's document.
 * @returns `snapshot` or `derived`.
 */
export function embeddingRelation(
  document: JsonValue,
  nodePaths: ReadonlySet<string>,
  path: FieldPath,
  value: JsonValue,
  source: JsonValue,
): RevisionEmbeddingInput["relation"] {
  return sameJson(
    effectiveContext(document, nodePaths, path),
    effectiveContext(source, ROOT_PATHS, []),
  ) && sameJson(withoutContext(value), withoutContext(source))
    ? "snapshot"
    : "derived";
}

/**
 * Reads the current snapshots of the resources registered under IRIs.
 * @returns The snapshots by IRI; resources whose current revision is not a
 *          snapshot, and unregistered IRIs, are absent.
 */
async function currentSnapshots(
  tx: Transaction,
  iris: readonly string[],
): Promise<ReadonlyMap<string, SourceSnapshot>> {
  if (iris.length === 0) return new Map();
  const rows = await tx
    .select({
      iri: schema.resources.iri,
      revisionId: schema.resourceRevisions.id,
      document: schema.resourceRevisions.document,
    })
    .from(schema.resources)
    .innerJoin(
      schema.resourceHeads,
      eq(schema.resourceHeads.resourceId, schema.resources.id),
    )
    .innerJoin(
      schema.resourceRevisions,
      and(
        eq(
          schema.resourceRevisions.resourceId,
          schema.resourceHeads.resourceId,
        ),
        eq(schema.resourceRevisions.id, schema.resourceHeads.revisionId),
      ),
    )
    .where(
      and(
        inArray(schema.resources.iri, [...new Set(iris)]),
        eq(schema.resourceRevisions.kind, "snapshot"),
      ),
    );
  return new Map(
    rows.map(({ iri, revisionId, document }) => [
      iri,
      { revisionId, document: document as JsonValue },
    ]),
  );
}

async function storedSnapshots(
  tx: Transaction,
  ids: readonly Uuid[],
): Promise<ReadonlyMap<string, SourceSnapshot>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      revisionId: schema.resourceRevisions.id,
      document: schema.resourceRevisions.document,
    })
    .from(schema.resourceRevisions)
    .where(
      and(
        inArray(schema.resourceRevisions.id, [...new Set(ids)]),
        eq(schema.resourceRevisions.kind, "snapshot"),
      ),
    );
  return new Map(
    rows.map(({ revisionId, document }) => [
      revisionId.toLowerCase(),
      { revisionId, document: document as JsonValue },
    ]),
  );
}

/**
 * Finds where the documents a saved document embeds came from, as
 * `revisionEmbeddings` records it.  Only embedded documents, not `Link`s,
 * with an `id` other than the saved resource's own are considered, at any
 * depth.  Each takes its source from, in order:
 *
 *  1. the revision this write saved for its IRI, as a new nested resource
 *     or an edited object;
 *  2. the revision the request declares for its submitted path, for a
 *     document the request submitted rather than one the server generated;
 *  3. the current snapshot of the resource registered under its IRI, only
 *     when the embedded document keeps it.
 *
 * Any other has an unknown source and no row.
 * @param tx The write's transaction.
 * @param resource The prepared resource about to be saved.
 * @param declared Declared source revisions by the keys of submitted paths.
 * @param saved The snapshots this write has saved so far, by IRI.
 * @returns The embeddings to save with the resource's revision.
 */
export async function findEmbeddings(
  tx: Transaction,
  resource: PreparedResource,
  declared: ReadonlyMap<string, Uuid>,
  saved: ReadonlyMap<string, SourceSnapshot>,
): Promise<RevisionEmbeddingInput[]> {
  const nodes = interpretDocument(resource.document) ?? [];
  const nodePaths = new Set(nodes.map(({ path }) => pathKey(path)));
  const embedded = nodes.filter(
    (node): node is InterpretedNode & { readonly iri: string } =>
      node.path.length > 0 &&
      node.kind !== "link" &&
      node.iri != null &&
      node.iri !== resource.iri,
  );
  const declaredFor = (node: InterpretedNode): Uuid | undefined =>
    resource.generated
      ? undefined
      : declared.get(pathKey([...resource.path, ...node.path]));
  const [declaredSnapshots, currentByIri] = await Promise.all([
    storedSnapshots(
      tx,
      embedded.flatMap((node) => {
        const id = saved.has(node.iri) ? undefined : declaredFor(node);
        return id == null ? [] : [id];
      }),
    ),
    currentSnapshots(
      tx,
      embedded
        .filter((node) => !saved.has(node.iri) && declaredFor(node) == null)
        .map(({ iri }) => iri),
    ),
  ]);
  const relation = (node: InterpretedNode, source: SourceSnapshot) =>
    embeddingRelation(
      resource.document,
      nodePaths,
      node.path,
      node.value,
      source.document,
    );
  return embedded.flatMap((node): RevisionEmbeddingInput[] => {
    const own = saved.get(node.iri);
    const declaredId = own == null ? declaredFor(node) : undefined;
    const source =
      own ??
      (declaredId == null
        ? currentByIri.get(node.iri)
        : declaredSnapshots.get(declaredId.toLowerCase()));
    if (source == null) return [];
    const found = relation(node, source);
    // An undeclared document matched by IRI alone has a source only when
    // it keeps the current snapshot.
    if (own == null && declaredId == null && found !== "snapshot") return [];
    return [
      { path: node.path, sourceRevisionId: source.revisionId, relation: found },
    ];
  });
}

/**
 * Indexes a request's declared sources by the keys of their paths.
 * @returns The declared revision IDs.
 */
export function declaredSources(
  sources: readonly EmbeddedSource[] | undefined,
): ReadonlyMap<string, Uuid> {
  return new Map(
    (sources ?? []).map(({ path, revisionId }) => [pathKey(path), revisionId]),
  );
}
