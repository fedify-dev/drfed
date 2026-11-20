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
import {
  ADDRESSING_PROPERTIES,
  DIAGNOSTIC_REASONS,
  type DocumentNode,
  type FieldPath,
  type JsonValue,
  describeDocument,
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

/** A snapshot this write saved, with the sources recorded for it. */
export interface SavedSnapshot extends SourceSnapshot {
  readonly embeddings: readonly RevisionEmbeddingInput[];
}

/**
 * A revision whose contents a generated activity carries: it embeds the
 * revision's document, as an `Update` does, copies its addressing, or
 * both.
 */
export interface CarriedRevision extends SavedSnapshot {
  /**
   * Where the activity embeds the revision's document, or null when it
   * refers to it by IRI, as a `Delete` does.
   */
  readonly embeddedAt: FieldPath | null;
}

/**
 * The source keys under which a document writes its own addressing, which
 * a generated activity copies as written.
 * @returns The keys, in the order of `ADDRESSING_PROPERTIES`; none when the
 *          validator cannot read the document.
 */
export function addressingKeys(document: JsonObject): readonly string[] {
  const root = describeDocument(document)?.[0];
  return ADDRESSING_PROPERTIES.flatMap((property) => [
    ...(root?.properties.get(property) ?? []),
  ]);
}

/**
 * Loads the sources recorded for a stored revision.
 * @returns The recorded embeddings.
 */
export async function loadEmbeddings(
  tx: Transaction,
  revisionId: Uuid,
): Promise<RevisionEmbeddingInput[]> {
  return await tx
    .select({
      path: schema.revisionEmbeddings.path,
      sourceRevisionId: schema.revisionEmbeddings.sourceRevisionId,
      relation: schema.revisionEmbeddings.relation,
    })
    .from(schema.revisionEmbeddings)
    .where(eq(schema.revisionEmbeddings.revisionId, revisionId));
}

/**
 * Loads the revisions that requests name as sources, with the IRIs of their
 * resources.
 * @param hidden The lowercase IDs of revisions the principal may not read,
 *               which are left out as if they did not exist.
 * @returns The revisions by their lowercase IDs; unknown and hidden IDs are
 *          absent.
 */
export async function loadSourceRevisions(
  db: Database | Transaction,
  ids: readonly Uuid[],
  hidden: ReadonlySet<string> = new Set(),
): Promise<ReadonlyMap<string, SourceRevision>> {
  const shown = ids.filter((id) => !hidden.has(id.toLowerCase()));
  if (shown.length === 0) return new Map();
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
    .where(inArray(schema.resourceRevisions.id, [...new Set(shown)]));
  return new Map(
    rows.map(({ id, kind, iri }) => [id.toLowerCase(), { iri, kind }]),
  );
}

/**
 * Checks the sources a request declares against the submitted document:
 * each names, once, an embedded document that is not a `Link`, is not a new
 * resource of the write, and has an `id` other than that of a resource the
 * write saves, since a source is always a revision of another resource, and
 * a stored snapshot of the resource registered under that `id` that the
 * principal may read.  Every failure of the named revision, whether it does
 * not exist, is no snapshot, belongs to another resource, or may not be read,
 * is one and the same `source_unavailable`, so that it tells nothing of
 * revisions the principal may not read.
 * @param sources The declared sources.
 * @param nodes The documents the submitted document describes.
 * @param newPaths The keys of the paths of the write's new resources.
 * @param ownIris The IRIs of the existing resources the write saves, such as
 *                the object an edit changes.
 * @param revisions Looks up the declared revisions the principal may read.
 * @returns Why a declaration is invalid, or null.
 */
export async function checkSources(
  sources: readonly EmbeddedSource[],
  nodes: readonly DocumentNode[],
  newPaths: ReadonlySet<string>,
  ownIris: ReadonlySet<string>,
  revisions: (
    ids: readonly Uuid[],
  ) => Promise<ReadonlyMap<string, SourceRevision>>,
): Promise<LocalWriteError | null> {
  if (sources.length === 0) return null;
  const invalid = (message: string) => writeError("invalid_request", message);
  const byPath = new Map(nodes.map((node) => [pathKey(node.path), node]));
  const seen = new Set<string>();
  const named: { path: FieldPath; iri: string; revisionId: Uuid }[] = [];
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
    if (ownIris.has(iri)) {
      return invalid(`${key} is the object being saved, not another one.`);
    }
    named.push({ path, iri, revisionId });
  }
  const found = await revisions(named.map(({ revisionId }) => revisionId));
  const unavailable = named.filter(({ iri, revisionId }) => {
    const revision = found.get(revisionId.toLowerCase());
    return revision?.kind !== "snapshot" || revision.iri !== iri;
  });
  return unavailable.length === 0
    ? null
    : writeError(
        "source_unavailable",
        "A declared source is not a saved version of its document that " +
          "can be read.",
        unavailable.map(({ path }) => ({
          reason: "source_unavailable",
          ...DIAGNOSTIC_REASONS.source_unavailable,
          path,
          message: "The source is not a saved version that can be read.",
        })),
      );
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
 * depth.
 *
 * A document the request submitted takes each source from, in order:
 *
 *  1. the revision this write saved for its IRI, as a new nested resource;
 *     when the document keeps that revision, the documents it embeds take
 *     the sources recorded for that revision too;
 *  2. the revision the request declares for its submitted path.
 *
 * An activity the server generated takes its sources only from the revision
 * it carries, never from an IRI: see {@link carriedEmbeddings}.  Any other
 * embedded document has an unknown source and no row, even when it equals a
 * stored revision of the resource under its IRI: a source is never guessed.
 * @param tx The write's transaction.
 * @param resource The prepared resource about to be saved.
 * @param declared Declared source revisions by the keys of submitted paths,
 *                 already checked to be readable snapshots.
 * @param saved The snapshots this write has saved so far, by IRI.
 * @param carried For a generated activity, the revision it carries.
 * @returns The embeddings to save with the resource's revision.
 */
export async function findEmbeddings(
  tx: Transaction,
  resource: PreparedResource,
  declared: ReadonlyMap<string, Uuid>,
  saved: ReadonlyMap<string, SavedSnapshot>,
  carried?: CarriedRevision,
): Promise<RevisionEmbeddingInput[]> {
  if (resource.generated) return carriedEmbeddings(resource, carried);
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
    saved.has(node.iri ?? "")
      ? undefined
      : declared.get(pathKey([...resource.path, ...node.path]));
  const declaredSnapshots = await storedSnapshots(
    tx,
    embedded.flatMap((node) => {
      const id = declaredFor(node);
      return id == null ? [] : [id];
    }),
  );
  const direct = embedded.flatMap((node): RevisionEmbeddingInput[] => {
    const declaredId = declaredFor(node);
    const source =
      saved.get(node.iri) ??
      (declaredId == null
        ? undefined
        : declaredSnapshots.get(declaredId.toLowerCase()));
    if (source == null) return [];
    const relation = embeddingRelation(
      resource.document,
      nodePaths,
      node.path,
      node.value,
      source.document,
    );
    return [{ path: node.path, sourceRevisionId: source.revisionId, relation }];
  });
  const recorded = new Set(direct.map(({ path }) => pathKey(path)));
  const inherited = direct.flatMap(({ path, sourceRevisionId, relation }) =>
    relation === "snapshot"
      ? [...saved.values()]
          .filter(({ revisionId }) => revisionId === sourceRevisionId)
          .flatMap(({ embeddings }) => embeddings)
          .map((embedding) => ({
            ...embedding,
            path: [...path, ...embedding.path],
          }))
          .filter((embedding) => !recorded.has(pathKey(embedding.path)))
      : [],
  );
  return [...direct, ...inherited];
}

/**
 * Finds the sources of a generated activity from the revision it carries.
 * The document it embeds, if any, comes from that revision, and when it
 * keeps that revision, everything inside it takes the sources recorded for
 * that revision at the same paths, and nothing else.  The addressing it
 * copies as written takes the sources recorded for the same keys of that
 * revision, with their relations: the copies are equal values under the
 * same root context.  Nothing is looked up by IRI, so an older copy of a
 * resource inside its own document never passes for a copy of the revision
 * the write saved under that IRI.
 * @param resource The generated activity.
 * @param carried The revision it carries; without one, nothing is recorded.
 * @returns The embeddings to save with the activity's revision.
 */
function carriedEmbeddings(
  resource: PreparedResource,
  carried: CarriedRevision | undefined,
): RevisionEmbeddingInput[] {
  if (carried == null) return [];
  const nodes = interpretDocument(resource.document) ?? [];
  const nodePaths = new Set(nodes.map(({ path }) => pathKey(path)));
  const at = carried.embeddedAt == null ? null : pathKey(carried.embeddedAt);
  const embedded = nodes
    .filter(({ path }) => pathKey(path) === at)
    .map(
      (node): RevisionEmbeddingInput => ({
        path: node.path,
        sourceRevisionId: carried.revisionId,
        relation: embeddingRelation(
          resource.document,
          nodePaths,
          node.path,
          node.value,
          carried.document,
        ),
      }),
    );
  const inherited = embedded
    .filter(({ relation }) => relation === "snapshot")
    .flatMap(({ path }) =>
      carried.embeddings.map((embedding) => ({
        ...embedding,
        path: [...path, ...embedding.path],
      })),
    );
  const keys = new Set(addressingKeys(carried.document as JsonObject));
  const copied = carried.embeddings.filter(
    ({ path }) => typeof path[0] === "string" && keys.has(path[0]),
  );
  return [...embedded, ...inherited, ...copied];
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
