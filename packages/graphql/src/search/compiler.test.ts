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

import assert from "node:assert/strict";
import { it } from "node:test";

import { compileStringOrIriEquality } from "@drfed/graphql/search/compiler";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { withTemporaryDatabase } from "../harness.test.ts";

const content = "https://www.w3.org/ns/activitystreams#content";
const object = "https://www.w3.org/ns/activitystreams#object";
const actor = "https://example.test/actors/ada";
const hostileText = "Ada's $1 -- 慧";
const unusualProperty = "https://example.test/properties/quoted'\"$";

function equality(
  path: readonly [string, ...string[]],
  kind: "string" | "iri",
  value: string,
) {
  return compileStringOrIriEquality(
    { kind: "comparison", operator: "eq", path, value: { kind, value } },
    sql`candidate.document`,
  );
}

it("matches any embedded value at the exact path without following references", async () => {
  await withTemporaryDatabase(async (db) => {
    const documents = [
      {
        id: "embedded",
        document: [
          {},
          {
            [object]: [
              { "@id": actor },
              {
                [content]: [
                  { "@value": "different" },
                  { "@value": hostileText, "@language": "en" },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "reference",
        document: [
          { [object]: [{ "@id": actor }] },
          { "@id": actor, [content]: [{ "@value": hostileText }] },
        ],
      },
      {
        id: "wrong-path",
        document: [{ [content]: [{ "@value": hostileText }] }],
      },
      { id: "missing", document: null },
      {
        id: "wrong-shape",
        document: [{ [object]: { [content]: hostileText } }],
      },
    ];
    const result = await db
      .select({
        id: sql<string>`candidate.id`,
        matched: equality([object, content], "string", hostileText),
      })
      .from(sql`jsonb_to_recordset(${JSON.stringify(documents)}::jsonb)
        as candidate(id text, document jsonb)`)
      .orderBy(sql`candidate.id`);
    assert.deepEqual(result, [
      { id: "embedded", matched: true },
      { id: "missing", matched: false },
      { id: "reference", matched: false },
      { id: "wrong-path", matched: false },
      { id: "wrong-shape", matched: false },
    ]);
  });
});

it("distinguishes IRI references, strings, and other value objects", async () => {
  await withTemporaryDatabase(async (db) => {
    const documents = [
      { id: "iri", document: [{ [object]: [{ "@id": actor }] }] },
      { id: "string", document: [{ [object]: [{ "@value": actor }] }] },
      {
        id: "typed-string",
        document: [
          {
            [object]: [
              {
                "@value": actor,
                "@type": "http://www.w3.org/2001/XMLSchema#string",
              },
            ],
          },
        ],
      },
      {
        id: "typed-time",
        document: [
          {
            [object]: [
              {
                "@value": actor,
                "@type": "http://www.w3.org/2001/XMLSchema#dateTime",
              },
            ],
          },
        ],
      },
      {
        id: "json",
        document: [{ [object]: [{ "@value": actor, "@type": "@json" }] }],
      },
      { id: "number", document: [{ [object]: [{ "@value": 42 }] }] },
    ];
    const result = await db
      .select({
        id: sql<string>`candidate.id`,
        iri: equality([object], "iri", actor),
        text: equality([object], "string", actor),
        number_text: equality([object], "string", "42"),
      })
      .from(sql`jsonb_to_recordset(${JSON.stringify(documents)}::jsonb)
        as candidate(id text, document jsonb)`)
      .orderBy(sql`candidate.id`);
    assert.deepEqual(result, [
      { id: "iri", iri: true, text: false, number_text: false },
      { id: "json", iri: false, text: false, number_text: false },
      { id: "number", iri: false, text: false, number_text: false },
      { id: "string", iri: false, text: true, number_text: false },
      { id: "typed-string", iri: false, text: true, number_text: false },
      { id: "typed-time", iri: false, text: false, number_text: false },
    ]);
  });
});

it("binds both full property paths and literal values as SQL parameters", () => {
  const query = new PgDialect().sqlToQuery(
    equality([object, unusualProperty], "string", hostileText),
  );
  assert.ok(query.params.includes(JSON.stringify([object, unusualProperty])));
  assert.ok(query.params.includes(hostileText));
  assert.ok(!query.sql.includes(unusualProperty));
  assert.ok(!query.sql.includes(hostileText));
});
