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
import { describe, it } from "node:test";

import {
  comparison,
  propertyPath,
  queryParser,
} from "@drfed/graphql/search/parser";
import { endOfInput, takeLeft } from "arcsecond";

describe("propertyPath", () => {
  const completePath = takeLeft(propertyPath)(endOfInput);
  const object = "https://www.w3.org/ns/activitystreams#object";
  const content = "tag:example.org,2026:한.글";

  it("preserves one or more full IRIs in traversal order", () => {
    for (const values of [[object], [object, content]]) {
      const result = completePath.run(
        `${values.map((value) => `.<${value}>`).join("")} `,
      );
      if (result.isError) assert.fail(result.error);
      assert.deepEqual(result.result, values);
    }
  });

  it("stops before an adjacent ordering operator", () => {
    const path = `.<${content}>`;
    for (const operator of ["<", "<=", ">", ">="]) {
      const result = propertyPath.run(`${path}${operator}`);
      if (result.isError) assert.fail(result.error);
      assert.deepEqual(result.result, [content]);
      assert.equal(result.index, Buffer.byteLength(path));
    }
  });

  it("rejects missing, incomplete, and shorthand segments", () => {
    for (const input of [
      "",
      `<${object}>`,
      `. <${object}>`,
      ".object",
      ".<relative>",
      `.<${object}`,
      `.<${object}>.`,
      `.<${object}> .<${content}>`,
    ]) {
      assert.equal(completePath.run(input).isError, true, input);
    }
  });
});

describe("comparison", () => {
  const completeComparison = takeLeft(comparison)(endOfInput);
  const property = "https://www.w3.org/ns/activitystreams#published";
  const actor = "https://example.org/ada";
  const time = 'TIME "2026-11-24T09:00:00.123456789+09:00"';
  const instant = { kind: "time", value: "2026-11-24T00:00:00.123456789Z" };

  it("produces the typed comparison for every supported operator", () => {
    for (const [input, operator, value] of [
      ['= "Ada"', "eq", { kind: "string", value: "Ada" }],
      [`= <${actor}>`, "eq", { kind: "iri", value: actor }],
      [`= ${time}`, "eq", instant],
      ['~= "a AND b"', "contains", { kind: "string", value: "a AND b" }],
      [`< ${time}`, "lt", instant],
      [`<= ${time}`, "le", instant],
      [`> ${time}`, "gt", instant],
      [`>= ${time}`, "ge", instant],
    ] as const) {
      const result = completeComparison.run(`.<${property}>${input}`);
      if (result.isError) assert.fail(result.error);
      assert.deepEqual(result.result, {
        kind: "comparison",
        path: [property],
        operator,
        value,
      });
    }
  });

  it("rejects literals that the operator does not accept", () => {
    for (const input of [
      `~= <${actor}>`,
      `~= ${time}`,
      '< "2026-11-24T00:00:00Z"',
      `<= <${actor}>`,
      '> "Ada"',
      `>= <${actor}>`,
      "= Ada",
      '<== TIME "2026-11-24T00:00:00Z"',
    ]) {
      assert.equal(
        completeComparison.run(`.<${property}> ${input}`).isError,
        true,
        input,
      );
    }
  });
});

describe("queryParser", () => {
  const property = "https://www.w3.org/ns/activitystreams#name";
  const query = (value: string) => `.<${property}> = ${JSON.stringify(value)}`;
  const node = (value: string) => ({
    kind: "comparison",
    path: [property],
    operator: "eq",
    value: { kind: "string", value },
  });
  const [ada, grace, lin] = ["Ada", "Grace", "Lin"].map(query);

  it("binds NOT tighter than AND and AND tighter than OR", () => {
    const result = queryParser.run(` ${ada} oR nOt ${grace} aNd ${lin} `);
    if (result.isError) assert.fail(result.error);
    assert.deepEqual(result.result, {
      kind: "or",
      left: node("Ada"),
      right: {
        kind: "and",
        left: { kind: "not", operand: node("Grace") },
        right: node("Lin"),
      },
    });
  });

  it("groups parenthesized expressions without adding nodes", () => {
    const result = queryParser.run(`NOT (${ada} OR (${grace}))`);
    if (result.isError) assert.fail(result.error);
    assert.deepEqual(result.result, {
      kind: "not",
      operand: { kind: "or", left: node("Ada"), right: node("Grace") },
    });
  });

  it("associates repeated binary operators to the left", () => {
    for (const [operator, kind] of [
      ["AND", "and"],
      ["OR", "or"],
    ]) {
      const result = queryParser.run(
        `${ada} ${operator} ${grace} ${operator} ${lin}`,
      );
      if (result.isError) assert.fail(result.error);
      assert.deepEqual(result.result, {
        kind,
        left: { kind, left: node("Ada"), right: node("Grace") },
        right: node("Lin"),
      });
    }
  });

  it("requires explicit operators and consumes the entire query", () => {
    for (const input of [
      "",
      `${ada} ${grace}`,
      `${ada} AND`,
      `${ada} OR )`,
      `(${ada}`,
      `()`,
      `NOT`,
      `NOTABLE ${ada}`,
      `${ada} trailing`,
    ]) {
      assert.equal(queryParser.run(input).isError, true, input);
    }
  });
});
