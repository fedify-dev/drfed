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

import { ensureResource } from "@drfed/models/resource";
import { appendResourceRevision } from "@drfed/models/resource-revision";
import { uuidV7 } from "@drfed/models/uuid";

import { type SeedCase, labelled } from "./case.mts";
import { ACTIVITY, AS } from "./writer.mts";

const UNREGISTERED_IRI = "https://remote.example/unregistered";
const UNKNOWN_IRI = "https://remote.example/unknown";

const nestedUndo: SeedCase = async ({ alice, writer }) => {
  const note = await writer.save({ type: "Note", content: "A liked note" });
  const undo = await writer.save(
    {
      type: "Undo",
      object: { type: "Like", actor: alice.actorIri, object: note.iri },
    },
    ACTIVITY,
  );
  return {
    number: 1,
    title: "Undo(Like(Note)) nesting",
    resources: [labelled("Undo", undo), labelled("Note", note)],
  };
};

const addTarget: SeedCase = async ({ alice, writer }) => {
  const note = await writer.save({ type: "Note", content: "A featured note" });
  const add = await writer.save(
    {
      type: "Add",
      object: note.iri,
      target: { type: "OrderedCollection", id: `${alice.actorIri}/featured` },
    },
    ACTIVITY,
  );
  return {
    number: 2,
    title: "Add with a collection target",
    resources: [labelled("Add", add)],
  };
};

const unresolvedReferences: SeedCase = async ({ db, writer }) => {
  await ensureResource(db, UNKNOWN_IRI);
  const undo = await writer.save(
    {
      type: "Undo",
      object: [
        { type: "Like", object: UNREGISTERED_IRI },
        { type: "Like", object: UNKNOWN_IRI },
      ],
    },
    ACTIVITY,
  );
  return {
    number: 3,
    title: "References to an unregistered IRI and one of an unknown kind",
    resources: [labelled("Undo", undo)],
  };
};

const intransitive: SeedCase = async ({ writer }) => ({
  number: 4,
  title: "Arrive without an object",
  resources: [
    labelled("Arrive", await writer.save({ type: "Arrive" }, ACTIVITY)),
  ],
});

const editedAfterCreate: SeedCase = async ({ writer }) => {
  const [note, create] = await writer.saveAll(
    { type: "Create", object: { type: "Note", content: "First version" } },
    [
      { path: ["object"], kind: "object", representation: "embedded" },
      ...ACTIVITY,
    ],
  );
  if (note == null || create == null) throw new Error("Missing a resource.");
  await writer.edit(note.id, { content: "Second version" });
  return {
    number: 5,
    title: "Create(Note), then the Note edited",
    resources: [labelled("Create", create), labelled("Note", note)],
  };
};

const extensionsAndUninterpreted: SeedCase = async ({ db, alice, writer }) => {
  const extended = await writer.save({
    "@context": [AS, { ex: "https://ext.example/ns#" }],
    type: "Note",
    content: "A note with an extension property",
    "ex:mood": { level: 3 },
  });
  const tagged = await ensureResource(db, `${alice.actorIri}/seed/${uuidV7()}`);
  // The validator refuses `tag`, so the common write cannot save this one.
  await appendResourceRevision(db, {
    resourceId: tagged.id,
    resourceKind: "object",
    expectedRevisionId: null,
    kind: "snapshot",
    capture: "local",
    document: {
      "@context": AS,
      id: tagged.iri,
      type: "Note",
      content: "A note that is not interpreted",
      tag: [{ type: "Mention", href: alice.actorIri }],
    },
  });
  return {
    number: 6,
    title: "Extension properties, and a document that is not interpreted",
    resources: [
      labelled("Note with an extension", extended),
      labelled("Uninterpreted Note", tagged),
    ],
  };
};

const deleted: SeedCase = async ({ writer }) => {
  const note = await writer.save({ type: "Note", content: "Soon deleted" });
  await writer.edit(note.id, { content: "Edited before deletion" });
  await writer.remove(note.id);
  return {
    number: 7,
    title: "A deleted object: a whiteout after two snapshots",
    resources: [labelled("Note", note)],
  };
};

/** Cases 1 to 7: how documents and histories are read. */
export const DOCUMENT_CASES: readonly SeedCase[] = [
  nestedUndo,
  addTarget,
  unresolvedReferences,
  intransitive,
  editedAfterCreate,
  extensionsAndUninterpreted,
  deleted,
];

const editedSingleChoicePoll: SeedCase = async ({ writer }) => {
  const [poll, create] = await writer.saveAll(
    {
      type: "Create",
      object: {
        type: "Question",
        name: "Which day should we meet?",
        oneOf: [
          { type: "Note", name: "Monday" },
          { type: "Note", name: "Tuesday" },
        ],
        closed: false,
      },
    },
    [
      { path: ["object"], kind: "object", representation: "embedded" },
      ...ACTIVITY,
    ],
  );
  if (poll == null || create == null) throw new Error("Missing a resource.");
  await writer.edit(poll.id, {
    oneOf: [
      { type: "Note", name: "Monday" },
      { type: "Note", name: "Wednesday" },
    ],
    closed: "2026-11-20T12:00:00Z",
  });
  return {
    number: 26,
    title: "An edited single-choice poll and its original Create snapshot",
    resources: [labelled("Question", poll), labelled("Create", create)],
  };
};

const multipleChoicePoll: SeedCase = async ({ writer }) => {
  const poll = await writer.save({
    type: "Question",
    name: "Which days are you available?",
    anyOf: [
      { type: "Note", name: "Thursday" },
      { type: "Note", name: "Friday" },
    ],
  });
  return {
    number: 27,
    title: "A standalone multiple-choice poll",
    resources: [labelled("Question", poll)],
  };
};

export const POLL_CASES: readonly SeedCase[] = [
  editedSingleChoicePoll,
  multipleChoicePoll,
];
