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

import { type LayoutContents, drfedLayoutProblem } from "./layout.mts";

const layout: LayoutContents = {
  entries: new Map([
    ["blobs", "directory"],
    ["drfed-image.json", "file"],
    ["index.json", "file"],
    ["oci-layout", "file"],
  ]),
  ociLayout: { imageLayoutVersion: "1.0.0" },
  index: { schemaVersion: 2, manifests: [] },
  metadata: {
    platform: "linux/arm64",
    build: { version: "0.2.0" },
    packages: ["models", "federation", "graphql", "web", "drfed"].map(
      (name) => ({ name: `@drfed/${name}` }),
    ),
  },
};
const withEntries = (
  change: (entries: Map<string, "file" | "directory" | "other">) => void,
): LayoutContents => {
  const entries = new Map(layout.entries);
  change(entries);
  return { ...layout, entries };
};

describe("drfedLayoutProblem()", () => {
  it("accepts a layout that image:build wrote", () => {
    assert.equal(drfedLayoutProblem(layout), undefined);
  });

  it("rejects another project's OCI layout", () => {
    const other = withEntries((entries) => entries.delete("drfed-image.json"));
    assert.match(
      drfedLayoutProblem({ ...other, metadata: undefined })!,
      /exactly/u,
    );
    assert.match(
      drfedLayoutProblem({ ...layout, metadata: { platform: "linux/amd64" } })!,
      /DrFed image/u,
    );
  });

  it("rejects a directory that merely contains an oci-layout entry", () => {
    for (const contents of [
      withEntries((entries) => entries.set("README.md", "file")),
      withEntries((entries) => entries.set("oci-layout", "directory")),
      withEntries((entries) => entries.set("blobs", "other")),
      { ...layout, ociLayout: undefined },
      { ...layout, ociLayout: { imageLayoutVersion: "2.0.0" } },
      { ...layout, index: { manifests: [] } },
    ]) {
      assert.ok(drfedLayoutProblem(contents));
    }
  });
});
