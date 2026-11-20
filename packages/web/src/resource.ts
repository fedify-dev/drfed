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

// Calculations and wording of the resource page, apart from rendering.

const ACTIVITY_STREAMS = "https://www.w3.org/ns/activitystreams#";
const SEQUENCE_PATTERN = /^[1-9]\d*$/v;
/** The largest value of GraphQL's `Int`. */
const MAXIMUM_SEQUENCE = 2_147_483_647;

/** The source keys and list indexes from the root of a saved document. */
export type Path = readonly (string | number)[];

/**
 * Narrows a `path` the GraphQL `JSON` scalar returns.
 * @returns The path, or `[]` for a value that is not one.
 */
export const toPath = (value: unknown): Path =>
  Array.isArray(value) &&
  value.every((token) => typeof token === "string" || Number.isInteger(token))
    ? (value as Path)
    : [];

/**
 * A key that compares two paths by their tokens.
 * @returns The key.
 */
export const pathKey = (path: Path): string => JSON.stringify(path);

/**
 * Escapes a reference token of a JSON Pointer (RFC 6901, section 3).
 * @returns The escaped token.
 */
const pointerToken = (token: string | number) =>
  String(token).replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * Writes a source path as a JSON Pointer (RFC 6901).
 * @returns The pointer, or `undefined` for the root, which is not shown.
 */
export const formatPointer = (path: Path): string | undefined =>
  path.length === 0
    ? undefined
    : `/${path.map((token) => pointerToken(token)).join("/")}`;

/**
 * The term of an ActivityStreams type, or any other type IRI in full.
 * @returns The term or the IRI.
 */
export const typeLabel = (iri: string): string =>
  iri.startsWith(ACTIVITY_STREAMS) && iri.length > ACTIVITY_STREAMS.length
    ? iri.slice(ACTIVITY_STREAMS.length)
    : iri;

/**
 * Reads the `revision` search parameter.
 * @returns The sequence, or `undefined` for a value that names none.
 */
export const parseSequence = (parameter: string): number | undefined => {
  if (!SEQUENCE_PATTERN.test(parameter)) return undefined;
  const sequence = Number(parameter);
  return sequence <= MAXIMUM_SEQUENCE ? sequence : undefined;
};

/**
 * The page of a resource, or of one of its revisions.
 * @returns The path and search string.
 */
export const resourceHref = (id: string, sequence?: number): string =>
  sequence === undefined
    ? `/resource/${encodeURIComponent(id)}`
    : `/resource/${encodeURIComponent(id)}?revision=${sequence}`;

/** A revision as the timeline places it. */
export interface TimelineRevision {
  readonly sequence: number;
}

/** One entry of the timeline, newest first. */
export type TimelineEntry<T extends TimelineRevision> =
  | { readonly type: "head-unreadable" }
  | { readonly type: "revision"; readonly revision: T; readonly head: boolean }
  | { readonly type: "gap"; readonly count: number };

/**
 * Lays out the loaded revisions with the gaps between their sequences.  The
 * gap below the oldest is known only once every page is loaded, and the gap
 * above an unreadable head is never known.
 * @param revisions The loaded revisions, newest first.
 * @param head The sequence of the current revision, or `undefined` when the
 *             viewer may not read it.
 * @param complete Whether no older revision is left to load.
 * @returns The timeline entries, newest first.
 */
export const timelineEntries = <T extends TimelineRevision>(
  revisions: readonly T[],
  head: number | undefined,
  complete: boolean,
): readonly TimelineEntry<T>[] => [
  ...(head === undefined && revisions.length > 0
    ? [{ type: "head-unreadable" } as const]
    : []),
  ...revisions.flatMap((revision, index): readonly TimelineEntry<T>[] => {
    const next = revisions[index + 1];
    const last = complete ? revision.sequence - 1 : 0;
    const gap =
      next === undefined ? last : revision.sequence - next.sequence - 1;
    return [
      { type: "revision", revision, head: revision.sequence === head },
      ...(gap > 0 ? [{ type: "gap", count: gap } as const] : []),
    ];
  }),
];

/** The messages of the resource page. */
export const WORDING = {
  gap: (count: number): string =>
    count === 1
      ? "1 revision you cannot read"
      : `${count} revisions you cannot read`,
  headUnreadable: "You cannot read the current revision.",
  missingRevision: "This resource has no such revision that you can read.",
  showLatest: "Show the latest revision",
  unreadableReference: "Details unavailable",
  sourceLink: (sequence: number): string => `From revision ${sequence}`,
  currentLink: "Current revision",
  unknownKind: "Unresolved IRI. DrFed stores no details for it.",
} as const;
