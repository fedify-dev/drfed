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

// A document nested deeper than the resource page expands, so that its
// guide lines, labels and the saved JSON below the third level can be seen.
//
// Keep dependent database writes sequential.
// oxlint-disable no-await-in-loop

import type { EmbeddedSource, JsonObject } from "@drfed/federation/local-write";
import type { Uuid } from "@drfed/models/uuid";

import { type CaseContext, type SeedCase, labelled } from "./case.mts";
import { ACTIVITY, loadHead, withoutContext } from "./writer.mts";

/** A saved level of the chain, ready to be embedded in the next. */
interface Level {
  readonly label: string;
  readonly id: Uuid;
  readonly iri: string;
  readonly revisionId: Uuid;
  /** The level as the next one embeds it. */
  readonly embedded: JsonObject;
  /** The sources it declared, by their paths below its root. */
  readonly sources: readonly EmbeddedSource[];
}

/** How each level wraps the one below it, from the bottom up. */
const WRAPPERS: readonly {
  readonly label: string;
  readonly kind: "object" | "activity";
  readonly key: string;
  readonly document: JsonObject;
}[] = [
  {
    label: "Create",
    kind: "activity",
    key: "object",
    document: { type: "Create" },
  },
  {
    label: "Like",
    kind: "activity",
    key: "object",
    document: { type: "Like" },
  },
  {
    label: "Announce",
    kind: "activity",
    key: "object",
    document: { type: "Announce" },
  },
  {
    label: "Announce of the Announce",
    kind: "activity",
    key: "object",
    document: { type: "Announce" },
  },
  {
    label: "Undo",
    kind: "activity",
    key: "object",
    document: { type: "Undo" },
  },
];

/**
 * The sources a level declares for the level it embeds under a key: that
 * level itself, and every source it declared, one key deeper.
 * @returns The sources.
 */
const sourcesOf = (key: string, inner: Level): readonly EmbeddedSource[] => [
  { path: [key], revisionId: inner.revisionId },
  ...inner.sources.map(({ path, revisionId }) => ({
    path: [key, ...path],
    revisionId,
  })),
];

/**
 * Saves a document as a resource of workspace A.
 * @returns The saved level.
 */
async function saveLevel(
  { db, writer }: CaseContext,
  label: string,
  document: JsonObject,
  kind: "object" | "activity",
  sources: readonly EmbeddedSource[],
): Promise<Level> {
  const saved = await writer.save(
    document,
    kind === "activity" ? ACTIVITY : undefined,
    sources.length === 0 ? undefined : sources,
  );
  const head = await loadHead(db, saved.id);
  return {
    label,
    id: saved.id,
    iri: saved.iri,
    revisionId: head.revisionId,
    embedded: withoutContext(head.document),
    sources,
  };
}

const deepChain: SeedCase = async (context) => {
  const levels: Level[] = [
    await saveLevel(
      context,
      "Note",
      { type: "Note", content: "The note at the bottom, five levels down" },
      "object",
      [],
    ),
  ];
  for (const { label, kind, key, document } of WRAPPERS) {
    const inner = levels.at(-1);
    if (inner == null) throw new Error("Missing the level below.");
    levels.push(
      await saveLevel(
        context,
        label,
        { ...document, [key]: inner.embedded },
        kind,
        sourcesOf(key, inner),
      ),
    );
  }
  const [bottom] = levels;
  if (bottom == null) throw new Error("Missing the bottom level.");
  // Every snapshot of the bottom note is now behind its current revision.
  await context.writer.edit(bottom.id, {
    content: "Edited after it was embedded",
  });
  return {
    number: 25,
    title:
      "Undo(Announce(Announce(Like(Create(Note))))), six levels with " +
      "a source declared at every depth, the bottom Note edited afterwards",
    resources: levels.toReversed().map((level) => labelled(level.label, level)),
  };
};

/** Case 25: a document nested past what the resource page expands. */
export const DEPTH_CASES: readonly SeedCase[] = [deepChain];
