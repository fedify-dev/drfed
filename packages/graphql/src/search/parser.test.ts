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
  validateSearchExpression,
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

  it("normalizes equivalent offsets without losing fractional precision", () => {
    for (const input of [
      "2026-11-24T00:00:00.123456789Z",
      "2026-11-24T09:00:00.123456789+09:00",
      "2026-11-23T18:30:00.123456789-05:30",
    ]) {
      const result = completeComparison.run(
        `.<${property}> <= TIME "${input}"`,
      );
      if (result.isError) assert.fail(result.error);
      assert.deepEqual(result.result?.value, instant);
    }
  });

  it("rejects missing offsets, invalid dates, and unsupported precision", () => {
    for (const input of [
      "2026-11-24T00:00:00",
      "2026-11-24T00:00:00+0900",
      "2026-11-24T00:00:00+24:00",
      "2026-02-29T00:00:00Z",
      "2026-11-24T24:00:00Z",
      "2026-11-24T00:00:00.1234567890Z",
    ]) {
      assert.equal(
        completeComparison.run(`.<${property}> = TIME "${input}"`).isError,
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

  it("decodes JSON escapes and keeps quoted keywords inside the literal", () => {
    const input = String.raw`.<${property}> = "say \"NOT AND OR\"\\path\n\uD55C"`;
    const result = queryParser.run(input);
    if (result.isError) assert.fail(result.error);
    assert.deepEqual(result.result, node('say "NOT AND OR"\\path\n한'));
  });

  it("rejects non-JSON string forms and escapes", () => {
    for (const literal of [
      "'Ada'",
      '"Ada',
      String.raw`"Ada\q"`,
      String.raw`"Ada\u12zz"`,
      '"Ada\nGrace"',
    ]) {
      const input = `.<${property}> = ${literal}`;
      assert.equal(queryParser.run(input).isError, true, input);
    }
  });

  it("rejects invalid absolute IRIs in paths and equality values", () => {
    for (const iri of [
      "https://[invalid]/",
      "https://example.org/%zz",
      "tag:bad|value",
    ]) {
      for (const input of [`.<${iri}> = "Ada"`, `.<${property}> = <${iri}>`]) {
        const result = queryParser.run(input);
        assert.equal(result.isError, true, input);
        if (result.isError) assert.match(result.error, /absolute IRI/iu);
      }
    }
  });

  it("bounds input size, recursive syntax, and the resulting tree", () => {
    for (const [input, message] of [
      [query("한".repeat(1500)), /4096 UTF-8 bytes/u],
      [`${"(".repeat(33)}${ada}${")".repeat(33)}`, /nesting exceeds 32/u],
      [`${"NOT ".repeat(33)}${ada}`, /nesting exceeds 32/u],
      [
        Array<string>(33).fill('.<urn:x> = "x"').join(" AND "),
        /depth exceeds 32/u,
      ],
    ] as const) {
      const result = queryParser.run(input);
      assert.equal(result.isError, true);
      if (result.isError) assert.match(result.error, message);
    }
    for (const input of [
      `${"(".repeat(32)}${ada}${")".repeat(32)}`,
      `${"NOT ".repeat(31)}${ada}`,
      Array<string>(32).fill('.<urn:x> = "x"').join(" AND "),
    ]) {
      assert.equal(queryParser.run(input).isError, false);
    }
  });

  it("validates externally supplied expression trees", () => {
    const valid = node("Ada");
    assert.deepEqual(validateSearchExpression(valid), {
      ok: true,
      expression: valid,
    });
    const cycle: { kind: "not"; operand?: unknown } = { kind: "not" };
    cycle.operand = cycle;
    for (const value of [
      null,
      { kind: "or", left: valid },
      { ...valid, path: [] },
      { ...valid, path: ["relative"] },
      { ...valid, operator: "lt" },
      { ...valid, operator: "unknown" },
      { ...valid, value: { kind: "time", value: "2026-11-24T09:00:00+09:00" } },
      cycle,
    ]) {
      assert.equal(validateSearchExpression(value).ok, false);
    }
  });
});
