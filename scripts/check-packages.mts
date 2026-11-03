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

// Check that the package order of scripts/packages.mts names every package
// under packages/, after the packages it depends on, and that
// docker/Containerfile installs the same tarballs in the same order.
// oxlint-disable no-console
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { packageOrder } from "./packages.mts";

const root = fileURLToPath(new URL("../", import.meta.url));

interface Workspace {
  /** The directory name under packages/. */
  readonly directory: string;
  /**
   * The internal packages it depends on, by the name after `@drfed/`, which
   * is also their directory name.
   */
  readonly dependencies: readonly string[];
}

/**
 * Compare the package order with the workspace and the Containerfile.
 * @returns One description per problem.
 */
function orderProblems(
  order: readonly string[],
  workspaces: readonly Workspace[],
  containerfile: string,
): readonly string[] {
  const directories = workspaces.map((workspace) => workspace.directory);
  const tarballs = [
    ...containerfile.matchAll(/drfed-(?<name>[\w-]+)-\$DRFED_VERSION\.tgz/gu),
  ].map((match) => match.groups!.name!);
  return [
    ...directories
      .filter((directory) => !order.includes(directory))
      .map((directory) => `packages/${directory} is missing from the order.`),
    ...order
      .filter((name) => !directories.includes(name))
      .map((name) => `${name} is in the order but not under packages/.`),
    ...workspaces.flatMap(({ directory, dependencies }) =>
      dependencies
        .filter(
          (dependency) => order.indexOf(dependency) > order.indexOf(directory),
        )
        .map((dependency) => `${directory} comes before ${dependency}.`),
    ),
    ...(tarballs.join() === order.join()
      ? []
      : [
          `docker/Containerfile installs ${tarballs.join(", ")}, not ${order.join(", ")}.`,
        ]),
  ];
}

async function readWorkspaces(): Promise<readonly Workspace[]> {
  const entries = await readdir(join(root, "packages"), {
    withFileTypes: true,
  });
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async ({ name }) => {
        const manifest = JSON.parse(
          await readFile(join(root, "packages", name, "package.json"), "utf8"),
        ) as {
          readonly dependencies?: Record<string, string>;
          readonly peerDependencies?: Record<string, string>;
        };
        const dependencies = Object.keys({
          ...manifest.dependencies,
          ...manifest.peerDependencies,
        })
          .filter((dependency) => dependency.startsWith("@drfed/"))
          .map((dependency) => dependency.slice("@drfed/".length));
        return { directory: name, dependencies };
      }),
  );
}

const problems = orderProblems(
  packageOrder,
  await readWorkspaces(),
  await readFile(join(root, "docker", "Containerfile"), "utf8"),
);
for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exit(1);
console.log(`Package order: ${packageOrder.join(", ")}`);
