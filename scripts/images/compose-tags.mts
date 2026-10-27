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

// The Compose examples under docker/ name the image by the checked-in package
// version.  bump-versions.mts rewrites the tags and check-versions.mts checks
// them, together with the pinned upgrade source of the container tests.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const docker = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docker",
);
const composeFiles = [
  "compose.pglite.yaml",
  "compose.postgres.yaml",
  "compose.web.yaml",
] as const;
const imageLine =
  /^(?<prefix>\s+image: ghcr\.io\/fedify-dev\/drfed:)(?<tag>\S+)$/gmu;

/**
 * Find every DrFed image tag in the Compose examples.
 * @returns The tags with the file names they appear in.
 */
export async function composeImageTags(): Promise<
  readonly { readonly file: string; readonly tag: string }[]
> {
  const tags = await Promise.all(
    composeFiles.map(async (file) => {
      const content = await readFile(join(docker, file), "utf8");
      return [...content.matchAll(imageLine)].map((match) => ({
        file,
        tag: match.groups!.tag!,
      }));
    }),
  );
  return tags.flat();
}

/** Point every Compose example at the given version. */
export async function setComposeImageTags(version: string): Promise<void> {
  await Promise.all(
    composeFiles.map(async (file) => {
      const path = join(docker, file);
      const content = await readFile(path, "utf8");
      await writeFile(
        path,
        content.replaceAll(imageLine, `$<prefix>${version}`),
        "utf8",
      );
    }),
  );
}

/**
 * Check docker/upgrade-source.json, which only digest-pinned images or exact
 * npm versions may name.
 * @returns A problem description, or undefined when the file is valid.
 */
export async function upgradeSourceProblem(): Promise<string | undefined> {
  const source = JSON.parse(
    await readFile(join(docker, "upgrade-source.json"), "utf8"),
  ) as Record<string, unknown>;
  const keys = Object.keys(source).sort().join(",");
  if (source.kind === "npm") {
    return keys === "kind,package" &&
      typeof source.package === "string" &&
      /^@drfed\/drfed@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(source.package)
      ? undefined
      : 'An npm upgrade source needs only "package": "@drfed/drfed@<version>".';
  }
  if (source.kind === "image") {
    return keys === "kind,ref" &&
      typeof source.ref === "string" &&
      /^ghcr\.io\/fedify-dev\/drfed:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?@sha256:[a-f0-9]{64}$/u.test(
        source.ref,
      )
      ? undefined
      : 'An image upgrade source needs only "ref": "ghcr.io/fedify-dev/drfed:<version>@sha256:<digest>".';
  }
  return 'The upgrade source "kind" must be "npm" or "image".';
}
