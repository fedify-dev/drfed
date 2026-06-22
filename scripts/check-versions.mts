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
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");

interface Package {
  readonly name: string;
  readonly version: string;
}

const packages = await loadPackages();
if (packages.length === 0) {
  console.error("No packages found under packages/.");
  process.exit(1);
}

const versions = new Map<string, string[]>();
for (const pkg of packages) {
  const list = versions.get(pkg.version);
  if (list == null) {
    versions.set(pkg.version, [pkg.name]);
  } else {
    list.push(pkg.name);
  }
}

if (versions.size === 1) {
  const [version, names] = [...versions.entries()][0];
  const count = names.length;
  console.log(
    `All ${count} package${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} at version ${version}.`,
  );
  process.exit(0);
}

console.error("Package versions are out of sync:\n");
for (const [version, names] of versions) {
  console.error(`  ${version}: ${names.join(", ")}`);
}
process.exit(1);

async function loadPackages(): Promise<Package[]> {
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const packages: Package[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageJsonPath = join(packagesDir, entry.name, "package.json");
    const content = await readFile(packageJsonPath, "utf8");
    const data = JSON.parse(content) as { name: string; version: string };
    packages.push({ name: data.name, version: data.version });
  }
  return packages;
}
