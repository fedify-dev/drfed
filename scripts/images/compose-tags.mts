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
// Any image line that seems to mean DrFed, however it is spelled.
const looseImageLine = /^\s*image:.*drfed/gmu;

/** The DrFed image tag of one Compose example, or why there is none. */
export type ImageTag =
  | { readonly tag: string; readonly problem?: undefined }
  | { readonly tag?: undefined; readonly problem: string };

/**
 * Find the single DrFed image tag of a Compose example.  A missing, quoted,
 * misspelled or repeated image line is a problem, so that no example silently
 * escapes the version check and the version bump.
 * @returns The tag, or the problem.
 */
export function findImageTag(content: string): ImageTag {
  const tags = [...content.matchAll(imageLine)].map(
    (match) => match.groups!.tag!,
  );
  const loose = [...content.matchAll(looseImageLine)].length;
  if (tags.length === 1 && loose === 1) return { tag: tags[0]! };
  return {
    problem:
      tags.length === 0 && loose === 0
        ? "has no ghcr.io/fedify-dev/drfed image line"
        : `needs exactly one line "image: ghcr.io/fedify-dev/drfed:<version>"; found ${loose} DrFed image lines, ${tags.length} of them in that form`,
  };
}

/**
 * Point a Compose example at the given version.
 * @returns The new content, or the problem that prevents the change.
 */
export function withImageTag(
  content: string,
  version: string,
): { readonly content: string } | { readonly problem: string } {
  const found = findImageTag(content);
  if (found.problem !== undefined) return { problem: found.problem };
  const updated = content.replaceAll(imageLine, `$<prefix>${version}`);
  const result = findImageTag(updated);
  return result.tag === version
    ? { content: updated }
    : { problem: `would name ${result.tag ?? "no image"}, not ${version}` };
}

const readExamples = () =>
  Promise.all(
    composeFiles.map(async (file) => ({
      file,
      path: join(docker, file),
      content: await readFile(join(docker, file), "utf8"),
    })),
  );

/**
 * Find the DrFed image tag of every Compose example.
 * @returns One tag or problem per file.
 */
export async function composeImageTags(): Promise<
  readonly ({ readonly file: string } & ImageTag)[]
> {
  return (await readExamples()).map(({ file, content }) => ({
    file,
    ...findImageTag(content),
  }));
}

/**
 * Point every Compose example at the given version.  Nothing is written
 * unless every example can be changed.
 */
export async function setComposeImageTags(version: string): Promise<void> {
  const updates = (await readExamples()).map((example) => ({
    ...example,
    ...withImageTag(example.content, version),
  }));
  const problems = updates.flatMap((update) =>
    "problem" in update ? [`docker/${update.file} ${update.problem}`] : [],
  );
  if (problems.length > 0) throw new Error(problems.join("\n"));
  await Promise.all(
    updates.map((update) => writeFile(update.path, update.content, "utf8")),
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
