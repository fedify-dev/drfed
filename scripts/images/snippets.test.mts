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

import { root } from "./layout.mts";
import { snippetRegion } from "./snippets.mts";

const script = [
  "#!/bin/sh",
  "set -u",
  "# region outer",
  "echo one",
  "#region inner",
  "echo two",
  "# endregion inner",
  "# endregion outer",
  "echo three",
].join("\n");

/**
 * Read which shell regions the container guide includes.
 * @returns Each region's file under docker/ and name.
 */
async function documentedRegions(): Promise<
  readonly { readonly file: string; readonly name: string }[]
> {
  const guide = await readFile(
    join(
      root,
      "docs",
      "installation",
      "container",
      "parts",
      "compose-workflow.md",
    ),
    "utf8",
  );
  return [
    ...guide.matchAll(
      /^<<< @\/\.\.\/docker\/(?<file>[\w.-]+\.sh)#(?<name>[\w-]+)\{sh\}$/gmu,
    ),
  ].map((match) => ({ file: match.groups!.file!, name: match.groups!.name! }));
}

describe("snippetRegion()", () => {
  it("keeps only the lines between the markers", () => {
    assert.equal(snippetRegion(script, "outer"), "echo one\necho two\n");
    assert.equal(snippetRegion(script, "inner"), "echo two\n");
  });

  it("rejects a missing or unterminated region", () => {
    assert.throws(() => snippetRegion(script, "other"), /No region other/u);
    assert.throws(
      () => snippetRegion("# region open\necho one\n", "open"),
      /No region open/u,
    );
  });

  it("finds the backup and restore regions of the guide", async () => {
    assert.deepEqual(await documentedRegions(), [
      { file: "backup.sh", name: "backup" },
      { file: "restore.sh", name: "restore" },
    ]);
  });

  it("starts every documented region with set -e", async () => {
    for (const { file, name } of await documentedRegions()) {
      // oxlint-disable-next-line no-await-in-loop
      const text = await readFile(join(root, "docker", file), "utf8");
      assert.equal(snippetRegion(text, name).split("\n")[0], "set -e", file);
    }
  });
});
