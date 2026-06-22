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
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");

const version = process.argv[2];
if (version == null) {
  console.error("Usage: node scripts/bump-versions.mts <version>");
  console.error("Example: node scripts/bump-versions.mts 1.2.0");
  process.exit(1);
}

if (!isSemver(version)) {
  console.error(`Invalid semver version: ${version}`);
  process.exit(1);
}

const packageJsonPaths = await findPackageJsonPaths();
if (packageJsonPaths.length === 0) {
  console.error("No packages found under packages/.");
  process.exit(1);
}

for (const path of packageJsonPaths) {
  const content = await readFile(path, "utf8");
  const data = JSON.parse(content) as { name: string; version: string };
  const oldVersion = data.version;
  data.version = version;
  const updated = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(path, updated, "utf8");
  console.log(`${data.name}: ${oldVersion} -> ${version}`);
}

const count = packageJsonPaths.length;
console.log(
  `\nBumped ${count} package${count === 1 ? "" : "s"} to ${version}.`,
);

async function findPackageJsonPaths(): Promise<string[]> {
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    paths.push(join(packagesDir, entry.name, "package.json"));
  }
  return paths;
}

function isSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    version,
  );
}
