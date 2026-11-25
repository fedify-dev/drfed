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
// Fixtures are appended one after another into one database.
// oxlint-disable no-await-in-loop

// The #149 worked examples, with expected expansions written out from the
// ActivityStreams context rather than computed by the expander under test.

import assert from "node:assert/strict";
import { it } from "node:test";

import { ensureResource } from "@drfed/models/resource";
import {
  type JsonObject,
  appendResourceRevision,
  loadRevisionExpansion,
} from "@drfed/models/resource-revision";

import {
  revisionBackends,
  revisionPostgresUrl,
  withRevisionDatabase,
} from "./resource-revision-fixture.ts";

const AS = "https://www.w3.org/ns/activitystreams";
const as = (term: string) => `${AS}#${term}`;
const DATE_TIME = "http://www.w3.org/2001/XMLSchema#dateTime";
const PUBLIC = as("Public");
const ALICE = "https://example.test/users/alice";
const BOB = "https://example.test/users/bob";
const NOTE = "https://example.test/notes/1";

const id = (iri: string) => [{ "@id": iri }];
const value = (literal: string) => [{ "@value": literal }];
const dateTime = (literal: string) => [
  { "@type": DATE_TIME, "@value": literal },
];
const type = (term: string) => [as(term)];

interface Fixture {
  readonly name: string;
  readonly document: JsonObject;
  readonly expanded: readonly unknown[];
}

const fixtures: readonly Fixture[] = [
  {
    name: "Create(Note)",
    document: {
      "@context": AS,
      id: "https://example.test/activities/create",
      type: "Create",
      actor: ALICE,
      to: [PUBLIC],
      published: "2026-11-01T00:00:00Z",
      object: {
        id: NOTE,
        type: "Note",
        attributedTo: ALICE,
        to: [PUBLIC],
        content: "<p>hello</p>",
        contentMap: { en: "<p>hello</p>" },
      },
    },
    expanded: [
      {
        "@id": "https://example.test/activities/create",
        "@type": type("Create"),
        [as("actor")]: id(ALICE),
        [as("to")]: id(PUBLIC),
        [as("published")]: dateTime("2026-11-01T00:00:00Z"),
        [as("object")]: [
          {
            "@id": NOTE,
            "@type": type("Note"),
            [as("attributedTo")]: id(ALICE),
            [as("to")]: id(PUBLIC),
            [as("content")]: [
              { "@value": "<p>hello</p>" },
              { "@value": "<p>hello</p>", "@language": "en" },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "Update(Note)",
    document: {
      "@context": AS,
      id: "https://example.test/activities/update",
      type: "Update",
      actor: ALICE,
      object: {
        id: NOTE,
        type: "Note",
        content: "<p>edited</p>",
        updated: "2026-11-02T00:00:00Z",
      },
    },
    expanded: [
      {
        "@id": "https://example.test/activities/update",
        "@type": type("Update"),
        [as("actor")]: id(ALICE),
        [as("object")]: [
          {
            "@id": NOTE,
            "@type": type("Note"),
            [as("content")]: value("<p>edited</p>"),
            [as("updated")]: dateTime("2026-11-02T00:00:00Z"),
          },
        ],
      },
    ],
  },
  {
    name: "Create(Question)",
    document: {
      "@context": AS,
      id: "https://example.test/activities/poll",
      type: "Create",
      actor: ALICE,
      object: {
        id: "https://example.test/questions/1",
        type: "Question",
        name: "Lunch?",
        oneOf: [
          { type: "Note", name: "Yes" },
          { type: "Note", name: "No" },
        ],
        endTime: "2026-11-03T00:00:00Z",
      },
    },
    expanded: [
      {
        "@id": "https://example.test/activities/poll",
        "@type": type("Create"),
        [as("actor")]: id(ALICE),
        [as("object")]: [
          {
            "@id": "https://example.test/questions/1",
            "@type": type("Question"),
            [as("name")]: value("Lunch?"),
            [as("oneOf")]: [
              { "@type": type("Note"), [as("name")]: value("Yes") },
              { "@type": type("Note"), [as("name")]: value("No") },
            ],
            [as("endTime")]: dateTime("2026-11-03T00:00:00Z"),
          },
        ],
      },
    ],
  },
  {
    name: "Undo(Like)",
    document: {
      "@context": AS,
      id: "https://example.test/activities/undo",
      type: "Undo",
      actor: BOB,
      object: {
        id: "https://example.test/activities/like",
        type: "Like",
        actor: BOB,
        object: NOTE,
      },
    },
    expanded: [
      {
        "@id": "https://example.test/activities/undo",
        "@type": type("Undo"),
        [as("actor")]: id(BOB),
        [as("object")]: [
          {
            "@id": "https://example.test/activities/like",
            "@type": type("Like"),
            [as("actor")]: id(BOB),
            [as("object")]: id(NOTE),
          },
        ],
      },
    ],
  },
  {
    name: "Accept(Follow)",
    document: {
      "@context": AS,
      id: "https://example.test/activities/accept",
      type: "Accept",
      actor: ALICE,
      object: {
        id: "https://example.test/activities/follow",
        type: "Follow",
        actor: BOB,
        object: ALICE,
      },
    },
    expanded: [
      {
        "@id": "https://example.test/activities/accept",
        "@type": type("Accept"),
        [as("actor")]: id(ALICE),
        [as("object")]: [
          {
            "@id": "https://example.test/activities/follow",
            "@type": type("Follow"),
            [as("actor")]: id(BOB),
            [as("object")]: id(ALICE),
          },
        ],
      },
    ],
  },
  {
    name: "Add with a collection target",
    document: {
      "@context": AS,
      id: "https://example.test/activities/add",
      type: "Add",
      actor: ALICE,
      object: NOTE,
      target: {
        id: `${ALICE}/featured`,
        type: "OrderedCollection",
      },
    },
    expanded: [
      {
        "@id": "https://example.test/activities/add",
        "@type": type("Add"),
        [as("actor")]: id(ALICE),
        [as("object")]: id(NOTE),
        [as("target")]: [
          { "@id": `${ALICE}/featured`, "@type": type("OrderedCollection") },
        ],
      },
    ],
  },
  {
    name: "Arrive without object",
    document: {
      "@context": AS,
      id: "https://example.test/activities/arrive",
      type: "Arrive",
      actor: ALICE,
      location: { type: "Place", name: "Seoul" },
    },
    expanded: [
      {
        "@id": "https://example.test/activities/arrive",
        "@type": type("Arrive"),
        [as("actor")]: id(ALICE),
        [as("location")]: [
          { "@type": type("Place"), [as("name")]: value("Seoul") },
        ],
      },
    ],
  },
];

for (const backend of revisionBackends) {
  const options = { skip: backend === "postgres" && !revisionPostgresUrl };

  it(
    `stores the expansions of the #149 fixtures on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        for (const { name, document, expanded } of fixtures) {
          const resource = await ensureResource(
            fixture.db,
            String(document.id),
          );
          const revision = await appendResourceRevision(fixture.db, {
            resourceId: resource.id,
            resourceKind: "activity",
            expectedRevisionId: null,
            kind: "snapshot",
            document,
            capture: "local",
          });
          const row = await loadRevisionExpansion(fixture.db, revision.id);
          assert.deepEqual(
            row,
            {
              revisionId: revision.id,
              outcome: "expanded",
              document: expanded,
              droppedTerms: [],
              undefinedTerms: [],
              failure: null,
              sourceRevisionId: null,
            },
            name,
          );
        }
      });
    },
  );
}
