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

// oxlint-disable no-console no-magic-numbers
import { glob, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import GPL from "./gpl.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INCLUDED = ["scripts/", "packages/*/src/", "packages/*/bin/"];
const EXCLUDED = ["**/dist/", "**/__generated__/**"];

type Extension = keyof typeof GPL;

interface AddLicenseProps {
  check?: true | undefined;
}

interface LicenseTarget {
  readonly path: string;
  readonly ext: Extension;
}

interface LicenseCheck extends LicenseTarget {
  readonly hasLicense: boolean;
}

export default async function addLicense(opt: AddLicenseProps) {
  const files = await findTargets().then(filterLicense);
  if (files.length === 0) {
    process.exit(0);
  }
  if (opt.check) {
    console.warn("Licenses are missing from some files:");
    listFiles(files);
    process.exit(1);
  }
  console.warn("Added licenses to the files that were missing them:");
  listFiles(files);

  await Promise.all(files.map(addLicenseHeader));
}

const findTargets = async (): Promise<LicenseTarget[]> =>
  (await Array.fromAsync(glob(INCLUDED.map(addAsteriskIfDir), GLOB_OPTION)))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .map((path) => ({ path, ext: extensionOf(path) }))
    .filter(isLicenseTarget);

const GLOB_OPTION = {
  cwd: ROOT,
  exclude: EXCLUDED,
  withFileTypes: true,
} as const;

const addAsteriskIfDir = (dir: string) =>
  dir.endsWith("/") ? `${dir}**/*` : dir;

const filterLicense = async (files: LicenseTarget[]): Promise<LicenseCheck[]> =>
  (await Array.fromAsync(files, checkLicense)).filter(
    (check) => !check.hasLicense,
  );

const extensionOf = (path: string): string => extname(path).slice(1);

const isLicenseTarget = (
  file: Readonly<{ path: string; ext: string }>,
): file is LicenseTarget => Object.hasOwn(GPL, file.ext);

async function checkLicense(target: LicenseTarget): Promise<LicenseCheck> {
  const header = GPL[target.ext];
  const lines = await readLines(target.path);
  const offset = shebangOffset(lines);
  const headerLineCount = header.split("\n").length;
  const actualHeader = lines.slice(offset, offset + headerLineCount).join("\n");
  return { ...target, hasLicense: actualHeader === header };
}

async function addLicenseHeader(target: LicenseTarget): Promise<void> {
  const added = updateLines(GPL[target.ext], await readLines(target.path));
  await writeFile(target.path, added, { encoding: "utf-8" });
}

const readLines = async (path: string): Promise<string[]> =>
  (await readFile(path, { encoding: "utf-8" })).split("\n");

const shebangOffset = (lines: readonly string[]): number =>
  lines[0]?.startsWith("#!") ? (lines[1]?.trim() === "" ? 2 : 1) : 0;

const updateLines = (header: string, lines: string[]): string =>
  Array.from(genLines(header, lines)).join("\n");

function* genLines(header: string, lines: string[]): Generator<string> {
  const offset = shebangOffset(lines);
  yield* lines.slice(0, offset);
  yield header;
  const next = lines.at(offset);
  if (next != null && next.trim() !== "") {
    yield "";
  }
  yield* lines.slice(offset);
}

function listFiles(files: LicenseTarget[]) {
  for (const file of files) {
    console.warn(`  - ${relative(ROOT, file.path)}`);
  }
}

if (import.meta.main) {
  await addLicense({
    check: process.argv.includes("--check") ? true : undefined,
  });
}
