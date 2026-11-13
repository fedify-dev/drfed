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
  type JsonObject,
  createLegacyObject,
  isLocalWriteError,
} from "@drfed/federation/local-write";
import { PUBLIC_IRI } from "@drfed/models/resource";
import type { Uuid } from "@drfed/models/uuid";

import { type CaseContext, type SeedCase, labelled } from "./case.mts";
import { ACTIVITY, AS, loadHead, withoutContext } from "./writer.mts";

interface SavedNote {
  readonly id: Uuid;
  readonly iri: string;
  /** The revision an editor would have loaded the note from. */
  readonly revisionId: Uuid;
  /** The note as another document embeds it. */
  readonly embedded: JsonObject;
}

async function saveNote(
  { db, writer }: CaseContext,
  content: string,
): Promise<SavedNote> {
  const { id, iri } = await writer.save({ type: "Note", content });
  const head = await loadHead(db, id);
  return {
    id,
    iri,
    revisionId: head.revisionId,
    embedded: withoutContext(head.document),
  };
}

const like = (object: JsonObject): JsonObject => ({ type: "Like", object });

const declared = (note: SavedNote) => [
  { path: ["object"], revisionId: note.revisionId },
];

const snapshotCurrent: SeedCase = async (context) => {
  const note = await saveNote(context, "Embedded as it is");
  const saved = await context.writer.save(like(note.embedded), ACTIVITY);
  return {
    number: 8,
    title: "Snapshot of a source that is still current",
    resources: [labelled("Like", saved), labelled("Note", note)],
  };
};

const snapshotSuperseded: SeedCase = async (context) => {
  const note = await saveNote(context, "Embedded, then edited");
  const saved = await context.writer.save(like(note.embedded), ACTIVITY);
  await context.writer.edit(note.id, { content: "Edited after the Like" });
  return {
    number: 9,
    title: "Snapshot of a source with a newer revision",
    resources: [labelled("Like", saved), labelled("Note", note)],
  };
};

const snapshotDeleted: SeedCase = async (context) => {
  const note = await saveNote(context, "Embedded, then deleted");
  const saved = await context.writer.save(like(note.embedded), ACTIVITY);
  await context.writer.remove(note.id);
  return {
    number: 10,
    title: "Snapshot of a source that was deleted",
    resources: [labelled("Like", saved), labelled("Note", note)],
  };
};

const derivedCurrent: SeedCase = async (context) => {
  const note = await saveNote(context, "Loaded by an editor");
  const saved = await context.writer.save(
    like({ ...note.embedded, content: "Changed before embedding" }),
    ACTIVITY,
    declared(note),
  );
  return {
    number: 11,
    title: "Derived from a declared source that is still current",
    resources: [labelled("Like", saved), labelled("Note", note)],
  };
};

const derivedSuperseded: SeedCase = async (context) => {
  const note = await saveNote(context, "Loaded, then edited apart");
  const saved = await context.writer.save(
    like({ ...note.embedded, content: "Changed before embedding" }),
    ACTIVITY,
    declared(note),
  );
  await context.writer.edit(note.id, { content: "Edited after the Like" });
  return {
    number: 12,
    title: "Derived from a declared source with a newer revision",
    resources: [labelled("Like", saved), labelled("Note", note)],
  };
};

const unknownSource: SeedCase = async (context) => {
  const { env, alice, writer } = context;
  const note = await saveNote(context, "Read by a script");
  await writer.edit(note.id, { content: "Edited before the script saved" });
  // The stale version matches no current revision, and nothing is declared.
  const stale = await writer.save(like(note.embedded), ACTIVITY);
  const legacy = await createLegacyObject(
    env,
    { accountId: alice.member.accountId },
    {
      actorId: alice.actorId,
      type: "Note",
      contentHtml: "<p>Created through createObject</p>",
      name: null,
      summary: null,
      language: null,
      sensitive: false,
      addressing: { to: [PUBLIC_IRI] },
    },
  );
  if (isLocalWriteError(legacy)) throw new Error(JSON.stringify(legacy));
  if (legacy.activityId == null) throw new Error("Missing the legacy Create.");
  return {
    number: 13,
    title: "Unknown sources: an undeclared stale copy and a legacy Create",
    resources: [
      labelled("Like of a stale copy", stale),
      labelled("Note", note),
      { label: "Legacy Create", id: legacy.activityId, iri: "" },
      { label: "Legacy Note", id: legacy.id, iri: "" },
    ],
  };
};

const reserialized: SeedCase = async (context) => {
  const note = await saveNote(context, "Serialized differently");
  const reordered = Object.fromEntries(
    Object.entries(note.embedded).toReversed(),
  );
  const kept = await context.writer.save(like(reordered), ACTIVITY);
  const recontextualized = await context.writer.save(
    like({
      "@context": [AS, { ex: "https://ext.example/ns#" }],
      ...note.embedded,
    }),
    ACTIVITY,
    declared(note),
  );
  return {
    number: 14,
    title: "Reordered keys stay a snapshot; another context is derived",
    resources: [
      labelled("Like with reordered keys", kept),
      labelled("Like with another context", recontextualized),
      labelled("Note", note),
    ],
  };
};

const deepSources: SeedCase = async (context) => {
  const { db, writer } = context;
  const note = await saveNote(context, "Embedded two levels deep");
  const liked = await writer.save(like(note.embedded), ACTIVITY);
  const head = await loadHead(db, liked.id);
  const undo = await writer.save(
    { type: "Undo", object: withoutContext(head.document) },
    ACTIVITY,
  );
  return {
    number: 15,
    title: "Undo(Like(Note)) with a source at both depths",
    resources: [
      labelled("Undo", undo),
      labelled("Like", liked),
      labelled("Note", note),
    ],
  };
};

/** Cases 8 to 15: where embedded documents came from. */
export const SOURCE_CASES: readonly SeedCase[] = [
  snapshotCurrent,
  snapshotSuperseded,
  snapshotDeleted,
  derivedCurrent,
  derivedSuperseded,
  unknownSource,
  reserialized,
  deepSources,
];
