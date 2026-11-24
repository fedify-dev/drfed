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
import {
  type DocumentExpansion,
  undefinedTermsOf,
} from "@drfed/models/expansion";
import type { DocumentLoader } from "@fedify/vocab-runtime";
import jsonld from "@fedify/vocab-runtime/jsonld";
import { getLogger } from "@logtape/logtape";

import { type GatheredContexts, expandGathered } from "./expansion.ts";

const logger = getLogger(["drfed", "federation"]);

type Expansion = Exclude<
  DocumentExpansion,
  { readonly outcome: "no_document" }
>;

export const AS_OBJECT = "https://www.w3.org/ns/activitystreams#object";
export const PROBE = "urn:drfed:embedded-object";
/**
 * How many places of a document are tried for its object, each by expanding
 * it again, so that a sender cannot make DrFed expand a large document over
 * and over.  An object not found within them is stored without its document,
 * which the activity's document still holds as received.
 */
const MAX_PROBES = 64;

export type Path = readonly (string | number)[];

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value != null && !Array.isArray(value);

/**
 * Every JSON object in a document, shallowest first, but those of contexts.
 * @returns Their paths.
 */
function objectPaths(document: unknown): Path[] {
  const paths: Path[] = [];
  let level: { readonly value: unknown; readonly path: Path }[] = [
    { value: document, path: [] },
  ];
  while (level.length > 0) {
    paths.push(
      ...level.filter(({ value }) => isRecord(value)).map(({ path }) => path),
    );
    level = level.flatMap(({ value, path }) =>
      Array.isArray(value)
        ? value.map((item, index) => ({ value: item, path: [...path, index] }))
        : isRecord(value)
          ? Object.entries(value)
              .filter(([key]) => key !== "@context")
              .map(([key, item]) => ({ value: item, path: [...path, key] }))
          : [],
    );
  }
  return paths;
}

export const valueAt = (document: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      Array.isArray(value) || isRecord(value)
        ? (value as Record<string | number, unknown>)[key]
        : undefined,
    document,
  );

export const replaceAt = (
  document: unknown,
  path: Path,
  value: unknown,
): unknown => {
  const [key, ...rest] = path;
  if (key == null) return value;
  if (Array.isArray(document)) {
    return document.map((item, index) =>
      index === key ? replaceAt(item, rest, value) : item,
    );
  }
  return isRecord(document)
    ? { ...document, [key]: replaceAt(document[key], rest, value) }
    : document;
};

/**
 * Whether the JSON object at a path is what Fedify reads as the object of
 * the activity: the first `as:object` of the first expanded node, under
 * whatever terms, aliases, graphs or containers the document uses.
 * @returns Whether a node in its place becomes the activity's object.
 */
async function isObjectAt(
  payload: unknown,
  path: Path,
  contextLoader: DocumentLoader,
): Promise<boolean> {
  try {
    const [activity] = await jsonld.expand(
      replaceAt(payload, path, { "@id": PROBE }) as Record<string, unknown>,
      { documentLoader: contextLoader, keepFreeFloatingNodes: true },
    );
    const objects = isRecord(activity) ? activity[AS_OBJECT] : undefined;
    const [first] = Array.isArray(objects) ? objects : [];
    return isRecord(first) && first["@id"] === PROBE;
  } catch {
    return false;
  }
}

/**
 * The object of a received activity, as it was received.
 * @returns The embedded object and its place, or undefined when it is not
 *          found within the first {@link MAX_PROBES} places of the document.
 */
export async function embeddedObject(
  payload: unknown,
  contextLoader: DocumentLoader,
): Promise<{ readonly document: unknown; readonly path: Path } | undefined> {
  // The document itself is the activity, never its object.
  const paths = objectPaths(payload).filter((path) => path.length > 0);
  for (const path of paths.slice(0, MAX_PROBES)) {
    // Each probe is tried in order; the first match is the object.
    // oxlint-disable-next-line no-await-in-loop
    if (await isObjectAt(payload, path, contextLoader)) {
      return { document: valueAt(payload, path), path };
    }
  }
  logger.warn("Could not find the object of an activity as received.");
  return undefined;
}

/**
 * The expansion of an object embedded in a received activity, taken from the
 * activity's expansion as the first `as:object` of its first node, which is
 * the node Fedify reads as the object, since the embedded document lacks the
 * context it inherits.  Its dropped terms are those the activity drops more
 * often than a document without the object does.
 * @returns The object's expansion.
 */
export async function embeddedExpansion(
  payload: unknown,
  path: Path,
  gathered: GatheredContexts,
  activity: Expansion,
): Promise<Expansion> {
  if (activity.outcome === "failed") return activity;
  const [node] = activity.document;
  const objects = isRecord(node) ? node[AS_OBJECT] : undefined;
  const [first] = Array.isArray(objects) ? objects : [];
  if (!isRecord(first)) {
    return {
      outcome: "failed",
      failure: "The expanded activity has no object node.",
    };
  }
  const counts = async (document: unknown) => {
    const dropped = new Map<string, number>();
    await expandGathered(document, gathered, {
      onDroppedTerm: (term) => dropped.set(term, (dropped.get(term) ?? 0) + 1),
    });
    return dropped;
  };
  const whole = await counts(payload);
  const outside = await counts(replaceAt(payload, path, { "@id": PROBE }));
  return {
    outcome: "expanded",
    document: [first],
    droppedTerms: [...whole]
      .filter(([term, count]) => count > (outside.get(term) ?? 0))
      .map(([term]) => term)
      .sort(),
    undefinedTerms: undefinedTermsOf([first]),
  };
}
