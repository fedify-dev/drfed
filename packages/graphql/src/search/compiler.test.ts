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

import {
  compileExpression,
  compileStringOrIriEquality,
  compileSubstring,
} from "@drfed/graphql/search/compiler";
import { queryParser } from "@drfed/search-query";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { withTemporaryDatabase } from "../harness.test.ts";

const content = "https://www.w3.org/ns/activitystreams#content";
const object = "https://www.w3.org/ns/activitystreams#object";
const actor = "https://example.test/actors/ada";
const hostileText = "Ada's $1 -- 慧";
const unusualProperty = "https://example.test/properties/quoted'\"$";

async function matchDocuments(query: string, documents: readonly unknown[]) {
  const parsed = queryParser.run(query);
  if (parsed.isError) assert.fail(parsed.error);
  assert.ok(parsed.result != null);
  const predicate = compileExpression(parsed.result, sql`candidate.document`);
  return await withTemporaryDatabase(async (db) => {
    const rows = await db
      .select({ matched: predicate })
      .from(sql`jsonb_array_elements(${JSON.stringify(documents)}::jsonb)
        with ordinality as candidate(document, position)`)
      .orderBy(sql`candidate.position`);
    return rows.map(({ matched }) => matched);
  });
}

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
  assert.match(query.sql, /\$\d+::text::jsonb/u);
  assert.ok(query.params.includes(hostileText));
  assert.ok(!query.sql.includes(unusualProperty));
  assert.ok(!query.sql.includes(hostileText));
});

it("matches case-insensitive substrings literally on the requested string path", async () => {
  await withTemporaryDatabase(async (db) => {
    const documents = [
      [
        {
          [content]: [{ "@value": "prefix aDa%_! suffix", "@language": "en" }],
        },
      ],
      [{ [content]: [{ "@value": "AdaXYZx!" }] }],
      [{ [content]: [{ "@value": "Ada%_x" }] }],
      [{ [object]: [{ "@value": "Ada%_!" }] }],
      [{ [content]: [{ "@id": "Ada%_!" }] }],
      [{ [content]: [{ "@value": "Ada%_!", "@type": "@json" }] }],
      [
        {
          [content]: [
            {
              "@value": "Ada%_!",
              "@type": "http://www.w3.org/2001/XMLSchema#dateTime",
            },
          ],
        },
      ],
      [
        {
          [content]: [
            {
              "@value": "Ada%_!",
              "@type": "http://www.w3.org/2001/XMLSchema#string",
            },
          ],
        },
      ],
      null,
    ];
    const predicate = compileSubstring(
      {
        kind: "comparison",
        path: [content],
        operator: "contains",
        value: { kind: "string", value: "Ada%_!" },
      },
      sql`candidate.document`,
    );
    const result = await db
      .select({ matched: predicate })
      .from(sql`jsonb_array_elements(${JSON.stringify(documents)}::jsonb)
        with ordinality as candidate(document, position)`)
      .orderBy(sql`candidate.position`);
    assert.deepEqual(
      result.map(({ matched }) => matched),
      [true, false, false, false, false, false, false, true, false],
    );
    const query = new PgDialect().sqlToQuery(predicate);
    assert.ok(query.params.includes("%Ada!%!_!!%"));
    assert.ok(!query.sql.includes("Ada"));
  });
});

it("compares typed instants exactly, including offsets and adjacent nanoseconds", async () => {
  const datatype = "http://www.w3.org/2001/XMLSchema#dateTime";
  const stamp = (value: unknown, type: string = datatype) => [
    { [content]: [{ "@value": value, "@type": type }] },
  ];
  const documents = [
    stamp("2026-11-24T00:00:00.123456788Z"),
    stamp("2026-11-24T09:00:00.123456789+09:00"),
    stamp("2026-11-23T18:30:00.123456789-05:30", `${datatype}Stamp`),
    stamp("2026-11-24T00:00:00.123456790Z"),
    stamp("2026-02-29T00:00:00.123456789Z"),
    stamp("2026-11-24T00:00:00.123456789"),
    stamp("2026-11-24T00:00:00.123456789Z", "@json"),
    [{ [content]: [{ "@value": "2026-11-24T00:00:00.123456789Z" }] }],
    stamp(42),
    [],
  ];
  const cases = [
    ["=", [false, true, true, false]],
    ["<", [true, false, false, false]],
    ["<=", [true, true, true, false]],
    [">", [false, false, false, true]],
    [">=", [false, true, true, true]],
  ] as const;
  await Promise.all(
    cases.map(async ([operator, expected]) => {
      assert.deepEqual(
        await matchDocuments(
          `.<${content}> ${operator} TIME "2026-11-24T00:00:00.123456789Z"`,
          documents,
        ),
        [...expected, false, false, false, false, false, false],
        operator,
      );
    }),
  );
});

it("composes Boolean predicates without requiring comparisons to match the same inline node", async () => {
  const first = `.<${object}>.<${content}> = "Ada"`;
  const second = `.<${object}>.<${content}> ~= "GRACE"`;
  const missing = `.<${content}> = <${actor}>`;
  const documents = [
    [
      {
        [object]: [
          { [content]: [{ "@value": "Ada" }] },
          {
            [content]: [{ "@value": "Grace Hopper" }],
          },
        ],
      },
    ],
    [{ [content]: [{ "@id": actor }] }],
    [],
  ];
  assert.deepEqual(
    await matchDocuments(`(${first} AND ${second}) OR ${missing}`, documents),
    [true, true, false],
  );
  assert.deepEqual(
    await matchDocuments(`NOT (${first} OR ${missing})`, documents),
    [false, false, true],
  );
});
