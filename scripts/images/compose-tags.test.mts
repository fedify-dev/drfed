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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { findImageTag, withImageTag } from "./compose-tags.mts";
import { root } from "./layout.mts";

const example = (image: string) =>
  `services:\n  postgres:\n    image: postgres:18\n  drfed:\n${image}    restart: unless-stopped\n`;
const line = "    image: ghcr.io/fedify-dev/drfed:0.2.0\n";

describe("findImageTag()", () => {
  it("finds the tag of every checked-in example", async () => {
    for (const file of [
      "compose.pglite.yaml",
      "compose.postgres.yaml",
      "compose.web.yaml",
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const content = await readFile(join(root, "docker", file), "utf8");
      assert.ok(findImageTag(content).tag, file);
    }
  });

  it("finds exactly one image line", () => {
    assert.deepEqual(findImageTag(example(line)), { tag: "0.2.0" });
  });

  it("rejects a missing, quoted, misspelled or repeated image line", () => {
    for (const image of [
      "",
      '    image: "ghcr.io/fedify-dev/drfed:0.2.0"\n',
      "    image: ghcr.io/fedify-dev/dfred:0.2.0\n",
      "    image: ghcr.io/fedify/drfed:0.2.0\n",
      line + line,
      `${line}    image: "ghcr.io/fedify-dev/drfed:0.1.0"\n`,
    ]) {
      const found = findImageTag(example(image));
      assert.equal(found.tag, undefined, image);
      assert.ok(found.problem, image);
    }
  });
});

describe("withImageTag()", () => {
  it("changes only the DrFed image line", () => {
    assert.deepEqual(withImageTag(example(line), "0.3.0"), {
      content: example("    image: ghcr.io/fedify-dev/drfed:0.3.0\n"),
    });
  });

  it("refuses an example whose image line it cannot find", () => {
    const quoted = example('    image: "ghcr.io/fedify-dev/drfed:0.2.0"\n');
    assert.ok("problem" in withImageTag(quoted, "0.3.0"));
  });
});
