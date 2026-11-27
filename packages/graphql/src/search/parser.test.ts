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

import { propertyPath } from "@drfed/graphql/search/parser";
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
