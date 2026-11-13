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

import { PUBLIC_IRI } from "@drfed/models/resource";

import {
  CAROL_FOLLOWERS_IRI,
  CAROL_IRI,
  type SeedCase,
  carolNote,
  labelled,
} from "./case.mts";
import { receiveNote } from "./received.mts";
import { ACTIVITY, loadHead, withoutContext } from "./writer.mts";

const privateEmbedding: SeedCase = async ({ db, alice, writer }) => {
  const iri = carolNote("followers-only");
  const note = await receiveNote(db, {
    iri,
    attributedTo: CAROL_IRI,
    content: "For my followers only",
    to: [CAROL_FOLLOWERS_IRI],
    deliveredTo: [alice],
  });
  const announce = await writer.save(
    { type: "Announce", object: withoutContext(note.document) },
    ACTIVITY,
  );
  const head = await loadHead(db, announce.id);
  const undo = await writer.save(
    { type: "Undo", object: withoutContext(head.document) },
    ACTIVITY,
  );
  return {
    number: 16,
    title:
      "Announce embedding a private Note only A received (17: the Undo " +
      "embedding that Announce)",
    resources: [
      labelled("Announce", announce),
      labelled("Undo (case 17)", undo),
      { label: "Carol's Note", id: note.resourceId, iri },
    ],
  };
};

const laterRestricted: SeedCase = async ({ db, alice, bob, writer }) => {
  const iri = carolNote("public-then-private");
  const first = await receiveNote(db, {
    iri,
    attributedTo: CAROL_IRI,
    content: "Public at first",
    to: [PUBLIC_IRI],
    deliveredTo: [alice, bob],
  });
  const liked = await writer.save(
    { type: "Like", object: withoutContext(first.document) },
    ACTIVITY,
  );
  await receiveNote(db, {
    iri,
    attributedTo: CAROL_IRI,
    content: "Restricted to followers later",
    to: [CAROL_FOLLOWERS_IRI],
    deliveredTo: [alice],
  });
  return {
    number: 18,
    title:
      "Like embedding a public revision whose Note A alone later received " +
      "a private revision of (19: the Note's history)",
    resources: [
      labelled("Like", liked),
      { label: "Carol's Note (case 19)", id: first.resourceId, iri },
    ],
  };
};

const receivedByBoth: SeedCase = async ({ db, alice, bob }) => {
  const iri = carolNote("followers-only-both");
  const note = await receiveNote(db, {
    iri,
    attributedTo: CAROL_IRI,
    content: "For my followers on both instances",
    to: [CAROL_FOLLOWERS_IRI],
    deliveredTo: [alice, bob],
  });
  return {
    number: 20,
    title: "A private Note both A and B received",
    resources: [{ label: "Carol's Note", id: note.resourceId, iri }],
  };
};

/** Cases 16 to 20: who may read a revision. */
export const ACCESS_CASES: readonly SeedCase[] = [
  privateEmbedding,
  laterRestricted,
  receivedByBoth,
];
