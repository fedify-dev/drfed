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
// oxlint-disable no-console no-await-in-loop no-magic-numbers node/no-top-level-await
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  type Descriptor,
  type ImageMetadata,
  imageAnnotations,
  metadataFile,
  readBlob,
  sha256Digest,
  singleImage,
  writeBlob,
} from "./images/layout.mts";

const execute = promisify(execFile);
const packageOrder = ["models", "federation", "graphql", "web", "drfed"];
const repository = "fedify-dev/drfed";
const workflow = ".github/workflows/main.yaml";
const cliArgs = process.argv.slice(2);
const command = cliArgs.shift();
function option(name: string, fallback: string): string {
  const index = cliArgs.indexOf(name);
  if (index < 0) return fallback;
  const value = cliArgs[index + 1];
  assert.ok(value && !value.startsWith("--"), `Missing ${name}`);
  return value;
}
const root = resolve(
  option("--root", fileURLToPath(new URL("../", import.meta.url))),
);
const artifacts = resolve(
  option("--artifacts", join(root, "release-artifacts")),
);
const fixture = cliArgs.includes("--fixture");
const githubApi = option("--github-api", "https://api.github.com/");
if (fixture) {
  const endpoint = new URL(githubApi);
  assert.ok(
    githubApi === "https://api.github.com/" ||
      (endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1"),
  );
} else assert.equal(githubApi, "https://api.github.com/");
const images = resolve(option("--images", join(root, "image-artifacts")));
const imageRepository = option(
  "--image-repository",
  "ghcr.io/fedify-dev/drfed",
);
if (fixture && imageRepository !== "ghcr.io/fedify-dev/drfed") {
  assert.match(imageRepository, /^127\.0\.0\.1:\d+\/drfed$/u);
} else assert.equal(imageRepository, "ghcr.io/fedify-dev/drfed");
const registry = option("--registry", "https://registry.npmjs.org/");
if (fixture) {
  const url = new URL(registry);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
} else assert.equal(registry, "https://registry.npmjs.org/");

interface Version {
  enabled: boolean;
  version: string;
  fullVersion: string;
  baseVersion: string;
  channel: string;
  sha: string;
  runNumber: string;
  runId: string;
  ref: string;
  workflow: string;
}
interface PackageManifest {
  name: string;
  version: string;
  repository?: { type: string; url: string; directory: string };
  publishConfig?: { access: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  main?: string;
  types?: string;
  exports?: unknown;
  bin?: Record<string, string>;
  drfedBuild?: Version;
}
interface Artifact {
  name: string;
  filename: string;
  integrity: string;
}
interface Bundle {
  build: Version;
  packages: Artifact[];
  notesIntegrity?: string;
  completions?: Artifact[];
}
interface RegistryVersion extends PackageManifest {
  dist: { integrity: string };
}
const semver =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
function parseVersion(value: string): RegExpExecArray {
  const match = semver.exec(value);
  assert.ok(match, `Unsupported version: ${value}`);
  assert.ok(value.length <= 256, "Version exceeds npm SemVer length");
  for (const component of match.slice(1, 4)) {
    assert.ok(
      BigInt(component!) <= BigInt(Number.MAX_SAFE_INTEGER),
      "Version component exceeds npm SemVer range",
    );
  }
  return match;
}
function compare(left: string, right: string): number {
  const lhs = parseVersion(left);
  const rhs = parseVersion(right);
  for (let index = 1; index <= 3; index += 1) {
    const difference = BigInt(lhs[index]!) - BigInt(rhs[index]!);
    if (difference) return difference > 0 ? 1 : -1;
  }
  if (!lhs[4] || !rhs[4]) return lhs[4] ? -1 : rhs[4] ? 1 : 0;
  const identifiers = lhs[4].split(".");
  const others = rhs[4].split(".");
  for (
    let index = 0;
    index < Math.max(identifiers.length, others.length);
    index += 1
  ) {
    const item = identifiers[index];
    const other = others[index];
    if (item === other) continue;
    if (item == null) return -1;
    if (other == null) return 1;
    const numeric = /^\d+$/u.test(item);
    const otherNumeric = /^\d+$/u.test(other);
    if (numeric && otherNumeric) return BigInt(item) > BigInt(other) ? 1 : -1;
    if (numeric !== otherNumeric) return numeric ? -1 : 1;
    return item > other ? 1 : -1;
  }
  return 0;
}
async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
async function run(binary: string, args: string[], cwd = root) {
  return await execute(binary, args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}
function digest(bytes: Uint8Array, algorithm = "sha512"): string {
  return `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
}
async function calculate(): Promise<Version> {
  const manifests = await Promise.all(
    packageOrder.map((name) =>
      json<PackageManifest>(join(root, "packages", name, "package.json")),
    ),
  );
  const baseVersion = manifests[0]!.version;
  parseVersion(baseVersion);
  for (const [index, manifest] of manifests.entries()) {
    assert.equal(manifest.name, `@drfed/${packageOrder[index]}`);
    assert.equal(
      manifest.version,
      baseVersion,
      "Mismatched checked-in package versions",
    );
  }
  const event = process.env.GITHUB_EVENT_PATH
    ? await json<{ deleted?: boolean }>(process.env.GITHUB_EVENT_PATH)
    : {};
  const ref = process.env.GITHUB_REF ?? "";
  const enabled =
    process.env.GITHUB_EVENT_NAME === "push" &&
    process.env.GITHUB_REPOSITORY === repository &&
    !event.deleted &&
    (ref === "refs/heads/main" || ref.startsWith("refs/tags/"));
  const sha = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  assert.match(sha, /^[a-f0-9]{40}$/u);
  if (enabled) {
    assert.match(process.env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/u);
    assert.equal(
      (
        await run("git", ["rev-parse", `${process.env.GITHUB_SHA}^{commit}`])
      ).stdout.trim(),
      sha,
    );
  }
  const runNumber = process.env.GITHUB_RUN_NUMBER ?? "0";
  const runId = process.env.GITHUB_RUN_ID ?? "0";
  let version = baseVersion;
  let fullVersion = version;
  let channel = "";
  if (enabled) {
    assert.match(runNumber, /^[1-9]\d*$/u);
    assert.match(runId, /^[1-9]\d*$/u);
    if (ref === "refs/heads/main") {
      assert.ok(
        !parseVersion(baseVersion)[4],
        "Main development base must be stable SemVer",
      );
      version = `${baseVersion}-dev.${runNumber}`;
      fullVersion = `${version}+${sha.slice(0, 8)}`;
      channel = "dev";
    } else {
      version = ref.slice("refs/tags/".length);
      parseVersion(version);
      assert.equal(
        version,
        baseVersion,
        "Tag must match every checked-in package version",
      );
      fullVersion = version;
      channel = parseVersion(version)[4] ? "next" : "latest";
    }
  }
  return {
    enabled,
    version,
    fullVersion,
    baseVersion,
    channel,
    sha,
    runNumber,
    runId,
    ref,
    workflow,
  };
}
function buildFromEnvironment(): Version {
  const build = JSON.parse(
    process.env.DRFED_RELEASE_BUILD ?? "null",
  ) as Version | null;
  assert.ok(build?.enabled, "Missing authorized version job output");
  parseVersion(build.version);
  assert.match(build.sha, /^[a-f0-9]{40}$/u);
  assert.equal(build.ref, process.env.GITHUB_REF);
  assert.equal(build.workflow, workflow);
  assert.equal(process.env.GITHUB_EVENT_NAME, "push");
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(build.runNumber, process.env.GITHUB_RUN_NUMBER);
  assert.equal(build.runId, process.env.GITHUB_RUN_ID);
  return build;
}
async function apply(): Promise<void> {
  const build = buildFromEnvironment();
  assert.deepEqual(build, await calculate());
  for (const name of packageOrder) {
    const path = join(root, "packages", name, "package.json");
    const manifest = await json<PackageManifest>(path);
    manifest.version = build.version;
    manifest.drfedBuild = build;
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
function checkManifest(
  manifest: PackageManifest,
  name: string,
  build: Version,
  files: Set<string>,
): void {
  assert.equal(manifest.name, `@drfed/${name}`);
  assert.equal(manifest.version, build.version);
  assert.deepEqual(manifest.drfedBuild, build);
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "https://github.com/fedify-dev/drfed.git",
    directory: `packages/${name}`,
  });
  assert.equal(manifest.publishConfig?.access, "public");
  for (const dependencies of [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    for (const [dependency, version] of Object.entries(dependencies ?? {})) {
      assert.ok(
        !/^(?:workspace:|catalog:|file:|link:|\.|\/)/u.test(version),
        `${dependency}: ${version}`,
      );
      if (dependency.startsWith("@drfed/")) {
        assert.equal(version, build.version);
      }
    }
  }
  function target(value: unknown): void {
    if (typeof value === "string") {
      assert.ok(
        files.has(`package/${value.replace(/^\.\//u, "")}`),
        `Missing entry point ${value}`,
      );
    } else if (value != null && typeof value === "object") {
      Object.values(value).forEach(target);
    }
  }
  target(manifest.main);
  target(manifest.types);
  target(manifest.exports);
  target(manifest.bin);
  if (name === "models") {
    assert.ok(files.has("package/dist/migrations-manifest.json"));
    assert.ok([...files].some((path) => path.endsWith("/migration.sql")));
  }
  if (name === "web") assert.ok(files.has("package/.output/server/index.mjs"));
  if (name === "drfed") {
    for (const commandName of ["server", "web", "migrate", "account"]) {
      assert.ok(files.has(`package/bin/drfed-${commandName}.mjs`));
    }
  }
}
function completionFiles(): { path: string; filename: string }[] {
  return ["server", "web", "migrate", "account"].flatMap((commandName) => {
    const binary = `drfed-${commandName}`;
    return ["bash", "zsh", "fish", "pwsh", "nu"].map((shell) => {
      const name =
        shell === "zsh"
          ? `_${binary}`
          : shell === "fish"
            ? `${binary}.fish`
            : shell === "pwsh"
              ? `${binary}.ps1`
              : shell === "nu"
                ? `${binary}.nu`
                : binary;
      return {
        path: `package/completions/${shell}/${name}`,
        filename: `${binary}.${shell}`,
      };
    });
  });
}
async function completionBytes(archive: string, path: string): Promise<Buffer> {
  // Completion scripts are UTF-8 text; extracting from the verified package
  // makes release assets independent of mutable build output on disk.
  const bytes = Buffer.from((await run("tar", ["-xOf", archive, path])).stdout);
  assert.ok(bytes.length > 0, `Empty completion script: ${path}`);
  return bytes;
}
async function inspect(
  archive: string,
  name: string,
  build: Version,
): Promise<void> {
  const manifest = JSON.parse(
    (await run("tar", ["-xOf", archive, "package/package.json"])).stdout,
  ) as PackageManifest;
  const files = new Set(
    (await run("tar", ["-tzf", archive])).stdout.trim().split("\n"),
  );
  checkManifest(manifest, name, build, files);
}
async function pack(): Promise<void> {
  const build = buildFromEnvironment();
  await mkdir(artifacts, { recursive: true });
  const entries: Artifact[] = [];
  for (const name of packageOrder) {
    const result = JSON.parse(
      (
        await run(
          "pnpm",
          ["pack", "--json", "--pack-destination", artifacts],
          join(root, "packages", name),
        )
      ).stdout,
    ) as { filename: string };
    const filename = basename(result.filename);
    const archive = join(artifacts, filename);
    await inspect(archive, name, build);
    entries.push({
      name: `@drfed/${name}`,
      filename,
      integrity: digest(await readFile(archive)),
    });
  }
  const bundle: Bundle = { build, packages: entries };
  if (build.channel !== "dev") {
    const notes = join(artifacts, "release-notes.md");
    await run("sacho", [
      "show",
      build.version,
      "--skip-heading",
      "--no-word-wrap",
      "--output-file",
      notes,
    ]);
    assert.ok(
      (await readFile(notes, "utf8")).trim(),
      "Missing frozen release notes",
    );
    bundle.notesIntegrity = digest(await readFile(notes));
    bundle.completions = [];
    const archive = join(artifacts, entries.at(-1)!.filename);
    for (const { path, filename } of completionFiles()) {
      const bytes = await completionBytes(archive, path);
      await writeFile(join(artifacts, filename), bytes);
      bundle.completions.push({
        name: filename,
        filename,
        integrity: digest(bytes),
      });
    }
  }
  await writeFile(
    join(artifacts, "manifest.json"),
    `${JSON.stringify(bundle, null, 2)}\n`,
  );
}
async function verify(): Promise<Bundle> {
  const bundle = await json<Bundle>(join(artifacts, "manifest.json"));
  const expected = buildFromEnvironment();
  assert.deepEqual(bundle.build, expected);
  assert.equal(
    (await run("git", ["rev-parse", "HEAD"])).stdout.trim(),
    expected.sha,
  );
  assert.equal(bundle.packages.length, packageOrder.length);
  for (const [index, entry] of bundle.packages.entries()) {
    const name = packageOrder[index]!;
    assert.equal(entry.name, `@drfed/${name}`);
    assert.equal(entry.filename, `drfed-${name}-${expected.version}.tgz`);
    assert.equal(
      entry.integrity,
      digest(await readFile(join(artifacts, entry.filename))),
    );
    await inspect(join(artifacts, entry.filename), name, expected);
  }
  if (expected.channel !== "dev") {
    assert.equal(
      bundle.notesIntegrity,
      digest(await readFile(join(artifacts, "release-notes.md"))),
    );
    assert.equal(bundle.completions?.length, completionFiles().length);
    const archive = join(artifacts, bundle.packages.at(-1)!.filename);
    for (const [index, { path, filename }] of completionFiles().entries()) {
      const entry: Artifact = bundle.completions![index]!;
      assert.equal(entry.name, filename);
      assert.equal(entry.filename, filename);
      const bytes = await readFile(join(artifacts, filename));
      assert.equal(entry.integrity, digest(bytes));
      assert.deepEqual(bytes, await completionBytes(archive, path));
    }
    const frozen = (
      await run("sacho", [
        "show",
        expected.version,
        "--skip-heading",
        "--no-word-wrap",
      ])
    ).stdout;
    assert.equal(
      await readFile(join(artifacts, "release-notes.md"), "utf8"),
      frozen,
    );
  } else {
    assert.equal(bundle.notesIntegrity, undefined);
    assert.equal(bundle.completions, undefined);
  }
  return bundle;
}
async function get<T>(url: string, github = false): Promise<T | null> {
  const requestUrl = new URL(url);
  // Match npm's fresh revision reads when deciding whether a write is needed.
  if (!github) requestUrl.searchParams.set("write", "true");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(requestUrl, {
        cache: github ? "default" : "no-store",
        signal: AbortSignal.timeout(10_000),
        headers: github
          ? {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`,
            }
          : { "Cache-Control": "no-cache" },
      });
    } catch (error) {
      if (attempt === 2) throw error;
      await delay(fixture ? 1 : 1000 * (attempt + 1));
      continue;
    }
    if (response.status === 404) return null;
    if (response.ok) return (await response.json()) as T;
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      await delay(fixture ? 1 : 1000 * (attempt + 1));
      continue;
    }
    throw new Error(`GET ${url}: HTTP ${response.status}`);
  }
  throw new Error("Unreachable request state");
}
async function ensureUnpublished(): Promise<void> {
  const build = buildFromEnvironment();
  assert.deepEqual(build, await calculate());
  for (const name of packageOrder) {
    const existing = await get<RegistryVersion>(
      new URL(
        `${encodeURIComponent(`@drfed/${name}`)}/${build.version}`,
        registry,
      ).href,
    );
    assert.equal(
      existing,
      null,
      "Original artifact missing for a published version; do not rebuild it",
    );
  }
}
async function published(entry: Artifact, build: Version): Promise<boolean> {
  const document = await get<RegistryVersion>(
    new URL(`${encodeURIComponent(entry.name)}/${build.version}`, registry)
      .href,
  );
  if (!document) return false;
  assert.equal(document.name, entry.name);
  assert.equal(document.version, build.version);
  assert.equal(
    document.dist.integrity,
    entry.integrity,
    `Immutable version conflict for ${entry.name}`,
  );
  assert.deepEqual(
    document.drfedBuild,
    build,
    `Build provenance conflict for ${entry.name}`,
  );
  return true;
}
async function tagTarget(build: Version): Promise<void> {
  if (build.channel === "dev") return;
  const tag = build.ref.slice("refs/tags/".length);
  assert.equal(tag, build.version);
  const remote = fixture
    ? option("--remote", "")
    : `https://github.com/${repository}.git`;
  assert.ok(remote);
  const result = (
    await run("git", [
      "ls-remote",
      "--tags",
      remote,
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ])
  ).stdout
    .trim()
    .split("\n");
  const peeled =
    result.find((line) => line.endsWith(`refs/tags/${tag}^{}`)) ??
    result.find((line) => line.endsWith(`refs/tags/${tag}`));
  assert.equal(
    peeled?.split(/\s+/u)[0],
    build.sha,
    "Remote tag was deleted or retargeted",
  );
}
async function confirmExistingPublication(
  entry: Artifact,
  build: Version,
): Promise<void> {
  // Only a conflicting retry needs registry confirmation. Successful uploads
  // are acknowledged by npm's exit status and require no read-after-write.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await published(entry, build)) return;
    if (attempt < 59) await delay(fixture ? 1 : 5000);
  }
  throw new Error(
    `Existing ${entry.name}@${build.version} could not be verified against the original artifacts`,
  );
}
async function publishOne(
  entry: Artifact,
  build: Version,
  staging: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await published(entry, build)) return false;
    await tagTarget(build);
    try {
      await run("npm", [
        "publish",
        join(artifacts, entry.filename),
        "--registry",
        registry,
        "--access",
        "public",
        "--tag",
        staging,
        "--ignore-scripts",
        ...(fixture ? [] : ["--provenance"]),
      ]);
    } catch (error) {
      if (await published(entry, build)) return false;
      const message = String(error);
      if (
        /(?:EPUBLISHCONFLICT|previously published versions?|immutable version)/iu.test(
          message,
        )
      ) {
        await confirmExistingPublication(entry, build);
        return false;
      }
      if (
        attempt === 2 ||
        !/(?:E429|E5\d\d|ETIMEDOUT|ECONNRESET|EAI_AGAIN)/u.test(message)
      ) {
        throw error;
      }
      await delay(fixture ? 1 : 2000);
      continue;
    }
    console.log(`Published ${entry.name}@${build.version}`);
    return true;
  }
  throw new Error(`Incomplete publication: ${entry.name}`);
}
/**
 * Order a channel's current build against this one, for npm and images alike.
 * @returns Whether the current build is newer and must keep the channel.
 */
function newerChannelBuild(
  currentVersion: string,
  current: Version | undefined,
  build: Version,
  subject: string,
): boolean {
  if (currentVersion === build.version) return false;
  if (build.channel !== "dev") {
    return compare(build.version, currentVersion) < 0;
  }
  // A manually seeded dev.0 has no CI run identity. Only accept this exact
  // same-base bootstrap; every CI dev run has a positive run number.
  if (
    current === undefined &&
    currentVersion === `${build.baseVersion}-dev.0`
  ) {
    return false;
  }
  assert.equal(
    current?.workflow,
    workflow,
    `Cannot order a foreign dev build of ${subject}`,
  );
  const runNumber = current?.runNumber;
  assert.equal(typeof runNumber, "string");
  assert.match(runNumber!, /^[1-9]\d*$/u);
  return BigInt(runNumber!) > BigInt(build.runNumber);
}
async function newerChannelVersion(
  entry: Artifact,
  currentVersion: string,
  build: Version,
): Promise<boolean> {
  if (currentVersion === build.version || build.channel !== "dev") {
    return newerChannelBuild(currentVersion, undefined, build, entry.name);
  }
  const current = await get<RegistryVersion>(
    new URL(`${encodeURIComponent(entry.name)}/${currentVersion}`, registry)
      .href,
  );
  assert.ok(current, `Missing current dev metadata for ${entry.name}`);
  assert.equal(current.name, entry.name);
  assert.equal(current.version, currentVersion);
  return newerChannelBuild(
    currentVersion,
    current.drfedBuild,
    build,
    entry.name,
  );
}
async function publish(): Promise<void> {
  const bundle = await verify();
  const { build } = bundle;
  if (!fixture) {
    assert.deepEqual(build, await calculate());
    assert.equal((await run("npm", ["--version"])).stdout.trim(), "12.2.0");
  }
  const staging = build.channel === "dev" ? "dev-staging" : "release-staging";
  await tagTarget(build);
  // Preflight the complete set so an existing conflict cannot cause new uploads.
  const existing = new Map<string, boolean>();
  for (const entry of bundle.packages) {
    existing.set(entry.name, await published(entry, build));
  }
  const uploaded = new Set<string>();
  for (const entry of bundle.packages) {
    if (
      !existing.get(entry.name) &&
      (await publishOne(entry, build, staging))
    ) {
      uploaded.add(entry.name);
    }
  }
  // All members exist before any shared tag is advanced. The workflow serializes
  // this entire operation; comparison also protects against late older builds.
  const tags: Record<string, string>[] = [];
  let newerExists = false;
  for (const entry of bundle.packages) {
    const current = await get<Record<string, string>>(
      new URL(`-/package/${encodeURIComponent(entry.name)}/dist-tags`, registry)
        .href,
    );
    assert.ok(current, `Missing tags for ${entry.name}`);
    tags.push(current);
    if (
      current[build.channel] &&
      (await newerChannelVersion(entry, current[build.channel]!, build))
    ) {
      newerExists = true;
    }
  }
  if (!newerExists) {
    for (const [index, entry] of bundle.packages.entries()) {
      if (tags[index]![build.channel] !== build.version) {
        await tagTarget(build);
        await run("npm", [
          "dist-tag",
          "add",
          `${entry.name}@${build.version}`,
          build.channel,
          "--registry",
          registry,
        ]);
      }
    }
  } else {
    console.log(
      "Newer channel version already exists; preserving shared dist-tags.",
    );
  }
  for (const [index, entry] of bundle.packages.entries()) {
    if (uploaded.has(entry.name) || tags[index]![staging]) {
      try {
        await run("npm", [
          "dist-tag",
          "rm",
          entry.name,
          staging,
          "--registry",
          registry,
        ]);
      } catch (error) {
        // Npm reads tags before deleting. A staging tag hidden by propagation
        // can be removed by a later run; publication and promotion succeeded.
        if (
          !String(error).includes(
            `${staging} is not a dist-tag on ${entry.name}`,
          )
        ) {
          throw error;
        }
        console.log(
          `Staging tag not visible for ${entry.name}; leaving cleanup to a later run.`,
        );
      }
    }
  }
  console.log(
    `Published complete package set: ${build.fullVersion} (${build.sha})`,
  );
}
interface Release {
  tag_name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; digest?: string; size: number; state: string }[];
}
async function uploadAsset(
  entry: Artifact,
  existing: Release,
  build: Version,
  directory = artifacts,
): Promise<void> {
  const bytes = await readFile(join(directory, entry.filename));
  const expectedDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const asset: Release["assets"][number] | undefined = existing.assets.find(
    (item) => item.name === entry.filename,
  );
  if (asset?.state === "uploaded") {
    assert.equal(
      asset.digest,
      expectedDigest,
      `Release asset conflict: ${asset.name}`,
    );
    assert.equal(asset.size, bytes.length);
  } else {
    if (asset) {
      // GitHub documents empty starter assets left by failed uploads as safe
      // to delete. Never clobber completed, active, or unknown-state assets.
      assert.equal(asset.state, "starter", "Unknown or active asset state");
      assert.equal(asset.size, 0);
      assert.equal(asset.digest ?? null, null);
    }
    await tagTarget(build);
    await run("gh", [
      "release",
      "upload",
      build.version,
      join(directory, entry.filename),
      ...(asset ? ["--clobber"] : []),
      "--repo",
      repository,
    ]);
  }
}
async function release(): Promise<void> {
  const bundle = await verify();
  const { build } = bundle;
  assert.ok(build.channel === "latest" || build.channel === "next");
  assert.deepEqual(build, await calculate());
  // The workflow requires a successful publish job; registry propagation must
  // not prevent releasing the already verified artifacts on GitHub.
  await tagTarget(build);
  const notes = await readFile(join(artifacts, "release-notes.md"), "utf8");
  const url = new URL(
    `repos/${repository}/releases/tags/${build.version}`,
    githubApi,
  ).href;
  let existing = await get<Release>(url, true);
  if (!existing) {
    const currentTags = await get<Record<string, string>>(
      new URL(
        `-/package/${encodeURIComponent("@drfed/drfed")}/dist-tags`,
        registry,
      ).href,
    );
    assert.ok(currentTags);
    const latest =
      build.channel === "latest" && currentTags.latest === build.version;
    try {
      await run("gh", [
        "release",
        "create",
        build.version,
        "--repo",
        repository,
        "--verify-tag",
        `--latest=${latest}`,
        "--target",
        build.sha,
        "--title",
        `DrFed ${build.version}`,
        "--notes-file",
        join(artifacts, "release-notes.md"),
        ...(build.channel === "next" ? ["--prerelease"] : []),
      ]);
    } catch (error) {
      existing = await get<Release>(url, true);
      if (!existing) throw error;
    }
    existing ??= await get<Release>(url, true);
  }
  assert.ok(existing);
  assert.equal(existing.tag_name, build.version);
  assert.equal(existing.body.trim(), notes.trim());
  assert.equal(existing.draft, false);
  assert.equal(existing.prerelease, build.channel === "next");
  for (const entry of [...bundle.packages, ...bundle.completions!]) {
    await uploadAsset(entry, existing, build);
  }
  // The image digest, build identity and tarball integrities, so that the
  // published image traces back to these release packages.
  const imageDirectory = join(images, "index");
  const imageManifest = await json<ImageIndexManifest>(
    join(imageDirectory, "image-manifest.json"),
  );
  assert.deepEqual(imageManifest.build, build);
  assert.deepEqual(imageManifest.packages, bundle.packages);
  await uploadAsset(
    {
      name: "image-manifest.json",
      filename: "image-manifest.json",
      integrity: digest(
        await readFile(join(imageDirectory, "image-manifest.json")),
      ),
    },
    existing,
    build,
    imageDirectory,
  );
}
const imageArchitectures = ["amd64", "arm64"] as const;
const indexMediaType = "application/vnd.oci.image.index.v1+json";
const provenanceType = "https://slsa.dev/provenance/v1";
/** The image-manifest.json of the merged index artifact. */
interface ImageIndexManifest {
  digest: string;
  size: number;
  build: Version;
  packages: Artifact[];
  base: ImageMetadata["base"];
  created: string;
  platforms: { platform: string; digest: string; size: number }[];
}
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
async function writeOutput(values: Record<string, string>): Promise<void> {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
/**
 * Check that manifest.json names this build and its tarballs are intact.
 * @returns The bundle manifest.
 */
async function bundleIdentity(): Promise<Bundle> {
  const bundle = await json<Bundle>(join(artifacts, "manifest.json"));
  assert.deepEqual(bundle.build, buildFromEnvironment());
  assert.equal(bundle.packages.length, packageOrder.length);
  for (const [index, entry] of bundle.packages.entries()) {
    assert.equal(entry.name, `@drfed/${packageOrder[index]}`);
    assert.equal(
      entry.integrity,
      digest(await readFile(join(artifacts, entry.filename))),
    );
  }
  return bundle;
}
/**
 * Merge the verified platform layouts into one deterministic image index.
 * @returns The serialized index and the manifest describing it.
 */
async function composeIndex(
  bundle: Bundle,
): Promise<{ bytes: Buffer; manifest: ImageIndexManifest }> {
  const platforms: Descriptor[] = [];
  let shared: ImageMetadata | undefined;
  for (const arch of imageArchitectures) {
    const layout = join(images, `linux-${arch}`);
    const metadata = await json<ImageMetadata>(join(layout, metadataFile));
    assert.equal(metadata.platform, `linux/${arch}`);
    assert.deepEqual(metadata.build, bundle.build, "Image of another build");
    assert.deepEqual(
      metadata.packages,
      bundle.packages,
      "Image built from other tarballs",
    );
    if (shared) {
      assert.deepEqual(metadata.base, shared.base, "Mismatched base images");
      assert.equal(metadata.created, shared.created);
    }
    shared = metadata;
    const { descriptor } = await singleImage(layout);
    platforms.push({
      mediaType: descriptor.mediaType,
      digest: descriptor.digest,
      size: descriptor.size,
      platform: { architecture: arch, os: "linux" },
    });
  }
  assert.ok(shared);
  const annotations = imageAnnotations(shared);
  // Fixed key order and sorted annotations keep the index bytes, and thus
  // its digest, a function of the platform images alone.
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: indexMediaType,
      manifests: platforms,
      annotations: Object.fromEntries(
        Object.entries(annotations).sort(([left], [right]) =>
          left < right ? -1 : 1,
        ),
      ),
    }),
  );
  return {
    bytes,
    manifest: {
      digest: sha256Digest(bytes),
      size: bytes.length,
      build: shared.build,
      packages: [...shared.packages],
      base: shared.base,
      created: shared.created,
      platforms: platforms.map((item, index) => ({
        platform: `linux/${imageArchitectures[index]}`,
        digest: item.digest,
        size: item.size,
      })),
    },
  };
}
async function imageIndex(): Promise<void> {
  const bundle = await bundleIdentity();
  const { bytes, manifest } = await composeIndex(bundle);
  const output = join(images, "index");
  const file = join(output, "image-manifest.json");
  if (await exists(file)) {
    // A rerun reuses the uploaded index; it must still match the layouts.
    assert.deepEqual(await json<ImageIndexManifest>(file), manifest);
    await readBlob(output, manifest);
    console.log(`Verified existing image index ${manifest.digest}`);
  } else {
    await mkdir(output, { recursive: true });
    await writeBlob(output, bytes);
    await writeFile(
      join(output, "oci-layout"),
      '{"imageLayoutVersion":"1.0.0"}',
    );
    await writeFile(
      join(output, "index.json"),
      JSON.stringify({
        schemaVersion: 2,
        mediaType: indexMediaType,
        manifests: [
          {
            mediaType: indexMediaType,
            digest: manifest.digest,
            size: manifest.size,
          },
        ],
      }),
    );
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote image index ${manifest.digest}`);
  }
  await writeOutput({ digest: manifest.digest });
}
/**
 * Read image-manifest.json and check it against the authorized build.
 * @returns The merged index manifest.
 */
async function imageIdentity(): Promise<ImageIndexManifest> {
  const manifest = await json<ImageIndexManifest>(
    join(images, "index", "image-manifest.json"),
  );
  assert.deepEqual(manifest.build, buildFromEnvironment());
  return manifest;
}
/** Rebuild the complete multi-platform layout from the three artifacts. */
async function assembleLayout(
  manifest: ImageIndexManifest,
  directory: string,
): Promise<void> {
  for (const source of [
    ...imageArchitectures.map((arch) => `linux-${arch}`),
    "index",
  ]) {
    await cp(join(images, source, "blobs"), join(directory, "blobs"), {
      recursive: true,
    });
  }
  await cp(join(images, "index", "index.json"), join(directory, "index.json"));
  await cp(join(images, "index", "oci-layout"), join(directory, "oci-layout"));
  const index = JSON.parse(
    (await readBlob(directory, manifest)).toString("utf8"),
  ) as { manifests: Descriptor[] };
  assert.deepEqual(
    index.manifests.map(({ digest: value }) => value),
    manifest.platforms.map(({ digest: value }) => value),
  );
  for (const descriptor of index.manifests) {
    const image = JSON.parse(
      (await readBlob(directory, descriptor)).toString("utf8"),
    ) as { config: Descriptor; layers: Descriptor[] };
    for (const blob of [image.config, ...image.layers]) {
      await readBlob(directory, blob);
    }
  }
}
// Whether a failed crane call means the tag or repository does not exist.
function missingImage(error: unknown): boolean {
  return /MANIFEST_UNKNOWN|NAME_UNKNOWN|status code 404|\b404 Not Found/u.test(
    String((error as { stderr?: unknown }).stderr ?? error),
  );
}
async function crane(args: string[]): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return (await run("crane", args)).stdout;
    } catch (error) {
      if (missingImage(error)) return null;
      if (attempt === 2) throw error;
      await delay(fixture ? 1 : 2000 * (attempt + 1));
    }
  }
  throw new Error("Unreachable request state");
}
async function imagePush(): Promise<void> {
  const manifest = await imageIdentity();
  const { build } = manifest;
  const reference = `${imageRepository}:${build.version}`;
  const directory = await mkdtemp(join(tmpdir(), "drfed-image-push-"));
  try {
    await assembleLayout(manifest, directory);
    const existing = (await crane(["digest", reference]))?.trim();
    if (existing) {
      assert.equal(
        existing,
        manifest.digest,
        `Immutable image version conflict for ${reference}`,
      );
      console.log(`Image ${reference} already exists with the same digest`);
    } else {
      await tagTarget(build);
      const refs = join(directory, "image-refs");
      // A single nested index in the layout is pushed as that index.
      await crane(["push", directory, reference, "--image-refs", refs]);
      const pushed = (await readFile(refs, "utf8")).trim();
      assert.equal(pushed, `${imageRepository}@${manifest.digest}`);
      console.log(`Pushed ${reference} (${manifest.digest})`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  await writeOutput({
    digest: manifest.digest,
    subject: imageRepository,
  });
}
/** Move the channel tag forward, then check that anyone can pull it. */
async function imageTags(): Promise<void> {
  const manifest = await imageIdentity();
  const { build } = manifest;
  assert.ok(["dev", "latest", "next"].includes(build.channel));
  const channel = `${imageRepository}:${build.channel}`;
  const current = await crane(["manifest", channel]);
  let target = manifest.digest;
  let write = true;
  if (current !== null) {
    const index = JSON.parse(current) as {
      annotations?: Record<string, string>;
    };
    const identity = index.annotations?.["org.drfed.build"];
    assert.ok(identity, `Cannot order a foreign image at ${channel}`);
    const currentBuild = JSON.parse(identity) as Version;
    const currentDigest = sha256Digest(Buffer.from(current));
    if (currentDigest === manifest.digest) {
      console.log(`${channel} already names ${build.version}`);
      write = false;
    } else if (
      newerChannelBuild(currentBuild.version, currentBuild, build, channel)
    ) {
      console.log(`${channel} names a newer build; preserving it.`);
      target = currentDigest;
      write = false;
    }
  }
  if (write) {
    await tagTarget(build);
    await crane([
      "tag",
      `${imageRepository}@${manifest.digest}`,
      build.channel,
    ]);
    console.log(`Tagged ${channel} as ${build.version}`);
  }
  await checkAnonymousPull(channel, target, build);
}
// Whether a failed crane call was refused for lack of credentials.
function unauthorizedImage(error: unknown): boolean {
  return /UNAUTHORIZED|DENIED|status code 40[13]|\b40[13] (?:Unauthorized|Forbidden)/u.test(
    String((error as { stderr?: unknown }).stderr ?? error),
  );
}
/**
 * Resolve a reference with no credentials, as `docker pull` would for anyone.
 * @returns Its digest, or null when the registry refuses anonymous reads.
 */
async function anonymousDigest(reference: string): Promise<string | null> {
  const config = await mkdtemp(join(tmpdir(), "drfed-anonymous-"));
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const { stdout } = await execute("crane", ["digest", reference], {
          cwd: root,
          env: { ...process.env, DOCKER_CONFIG: config },
          timeout: 120_000,
        });
        return stdout.trim();
      } catch (error) {
        if (unauthorizedImage(error)) return null;
        if (attempt === 2) throw error;
        await delay(fixture ? 1 : 2000 * (attempt + 1));
      }
    }
    throw new Error("Unreachable request state");
  } finally {
    await rm(config, { recursive: true, force: true });
  }
}
/**
 * Check that anyone can pull the channel.  A private package fails releases;
 * `dev` only warns, because the first main build publishes the package before
 * a maintainer can make it public.
 */
async function checkAnonymousPull(
  channel: string,
  expected: string,
  build: Version,
): Promise<void> {
  const resolved = await anonymousDigest(channel);
  if (resolved === null) {
    const message = `Anonymous pull of ${channel} is refused; make the package public, then rerun this job.`;
    if (build.channel !== "dev") throw new Error(message);
    console.log(`::warning::${message}`);
    return;
  }
  assert.equal(
    resolved,
    expected,
    `Anonymous pull of ${channel} resolves another image`,
  );
  console.log(`Anonymous pull of ${channel} resolves ${expected}`);
}
/**
 * The constraints every accepted attestation of this build must meet.
 * @returns The matching `gh attestation verify` options.
 */
function attestationConstraints(build: Version): string[] {
  return [
    "--repo",
    repository,
    "--signer-workflow",
    `${repository}/${workflow}`,
    "--source-ref",
    build.ref,
    "--source-digest",
    build.sha,
    "--predicate-type",
    provenanceType,
    "--deny-self-hosted-runners",
  ];
}
/**
 * Verify the attestation of an image from one source.
 * @returns Whether a matching attestation exists there.
 */
async function attested(
  subject: string,
  build: Version,
  extra: string[],
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await run("gh", [
        "attestation",
        "verify",
        subject,
        ...attestationConstraints(build),
        ...extra,
      ]);
      return true;
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      // The gh CLI reports absence as an API 404 or as an empty registry.
      if (
        /HTTP 404|no attestations found|no matching attestations/u.test(stderr)
      ) {
        return false;
      }
      if (attempt === 2 || !transientGhFailure(error)) throw error;
      await delay(fixture ? 1 : 1000 * (attempt + 1));
    }
  }
  throw new Error("Unreachable request state");
}
async function attestationState(
  manifest: ImageIndexManifest,
): Promise<"both" | "github-only" | "none"> {
  const subject = `oci://${imageRepository}@${manifest.digest}`;
  const github = await attested(subject, manifest.build, []);
  const registryCopy = await attested(subject, manifest.build, [
    "--bundle-from-oci",
  ]);
  // The actions/attest step stores on GitHub before attaching to GHCR.
  assert.ok(github || !registryCopy, "Registry-only attestation");
  return github ? (registryCopy ? "both" : "github-only") : "none";
}
/** Attach the stored GitHub attestation bundle the way actions/attest does. */
async function attachAttestation(manifest: ImageIndexManifest): Promise<void> {
  const subject = `oci://${imageRepository}@${manifest.digest}`;
  const directory = await mkdtemp(join(tmpdir(), "drfed-attestation-"));
  try {
    await execute(
      "gh",
      ["attestation", "download", subject, "--repo", repository],
      { cwd: directory, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const [file] = (await readdir(directory)).filter((name) =>
      name.endsWith(".jsonl"),
    );
    assert.ok(file, "Missing downloaded attestation bundles");
    const lines = (await readFile(join(directory, file), "utf8"))
      .split("\n")
      .filter((line) => line.trim());
    for (const [index, line] of lines.entries()) {
      const path = join(directory, `bundle-${index}.json`);
      await writeFile(path, line);
      try {
        await run("gh", [
          "attestation",
          "verify",
          subject,
          ...attestationConstraints(manifest.build),
          "--bundle",
          path,
        ]);
      } catch (error) {
        // Another workflow or ref may have attested the same digest; only a
        // bundle of this build may be copied to the registry.
        console.log(
          `Skipping a stored bundle: ${String((error as { stderr?: unknown }).stderr ?? error).trim()}`,
        );
        continue;
      }
      const bundle = JSON.parse(line) as { mediaType: string };
      const options = {
        imageName: imageRepository,
        imageDigest: manifest.digest,
        artifact: Buffer.from(line),
        mediaType: bundle.mediaType,
        annotations: {
          "dev.sigstore.bundle.content": "dsse-envelope",
          "dev.sigstore.bundle.predicateType": provenanceType,
        },
      };
      // A rerun can come after the release tag moved; recheck before writing.
      await tagTarget(manifest.build);
      if (fixture) {
        const response = await fetch(new URL("__attach", registry), {
          method: "POST",
          body: JSON.stringify(options),
        });
        assert.ok(response.ok, await response.text());
      } else {
        const { attachArtifactToImage, getRegistryCredentials } =
          await import("@sigstore/oci");
        await attachArtifactToImage({
          ...options,
          credentials: getRegistryCredentials(imageRepository),
        });
      }
      console.log(`Attached the stored attestation to ${manifest.digest}`);
      return;
    }
    throw new Error("No stored attestation meets the build constraints");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function imageAttestation(action: string | undefined): Promise<void> {
  const manifest = await imageIdentity();
  if (action === "status") {
    const state = await attestationState(manifest);
    console.log(`Attestation state of ${manifest.digest}: ${state}`);
    await writeOutput({ state });
  } else if (action === "attach") {
    assert.equal(await attestationState(manifest), "github-only");
    await attachAttestation(manifest);
  } else if (action === "verify") {
    assert.equal(
      await attestationState(manifest),
      "both",
      "The attestation must verify from GitHub and from the registry",
    );
    console.log(`Verified the attestation of ${manifest.digest}`);
  } else {
    throw new Error("Expected status, attach or verify");
  }
}
/** The payload of a docs deployment record, written by `docs-intent`. */
interface DocsRecord {
  version: string;
  channel: string;
  runNumber: string;
  sha: string;
}
interface GitHubDeployment {
  id: number;
  sha: string;
  environment: string;
  payload: unknown;
}
interface GitHubDeploymentStatus {
  id: number;
  state: string;
}
function docsEnvironment(build: Version): string {
  if (build.channel === "dev") return "docs-canary";
  assert.ok(
    build.channel === "latest" || build.channel === "next",
    `No docs environment for channel ${build.channel}`,
  );
  return "docs-release";
}
function requireGitHubToken(): void {
  assert.ok(
    fixture || process.env.GH_TOKEN,
    "GH_TOKEN is required to read and record docs deployments",
  );
}
async function githubList<T>(
  path: string,
  query: Record<string, string> = {},
): Promise<T[]> {
  const pageSize = 100;
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const url = new URL(path, githubApi);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("per_page", String(pageSize));
    url.searchParams.set("page", String(page));
    // A missing repository or deployment is an API failure here, never an
    // empty history; treating it as "no record" could deploy older docs.
    const result = await get<T[]>(url.href, true);
    assert.ok(Array.isArray(result), `GET ${url.href}: expected a list`);
    items.push(...result);
    if (result.length < pageSize) return items;
  }
}
function githubId(value: unknown): number {
  assert.ok(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    `Malformed GitHub identifier: ${String(value)}`,
  );
  return value;
}
function parseDocsRecord(
  value: unknown,
  environment: string,
  message: string,
): DocsRecord {
  let payload: Partial<Record<keyof DocsRecord, unknown>> | null;
  try {
    payload = typeof value === "string" ? JSON.parse(value) : value;
  } catch (cause) {
    throw new Error(message, { cause });
  }
  assert.ok(payload != null && typeof payload === "object", message);
  const { version, channel, runNumber, sha } = payload;
  assert.ok(
    typeof version === "string" &&
      typeof channel === "string" &&
      typeof runNumber === "string" &&
      typeof sha === "string",
    message,
  );
  const prerelease = parseVersion(version)[4];
  assert.ok(
    environment === "docs-canary"
      ? channel === "dev"
      : channel === (prerelease ? "next" : "latest"),
    message,
  );
  assert.match(runNumber, /^[1-9]\d*$/u, message);
  assert.match(sha, /^[a-f0-9]{40}$/u, message);
  return { version, channel, runNumber, sha };
}
function docsRecord(
  deployment: GitHubDeployment,
  environment: string,
): DocsRecord {
  // A malformed record fails closed rather than being ignored: skipping it
  // could let an older build overwrite newer docs. It cannot deadlock the
  // channel permanently, because posting `inactive` on that deployment makes
  // every later check skip it.
  const message = `Malformed docs deployment ${deployment.id} in ${environment}`;
  const record = parseDocsRecord(deployment.payload, environment, message);
  assert.equal(deployment.sha, record.sha, message);
  return record;
}
function sameDocsRecord(left: DocsRecord, right: DocsRecord): boolean {
  return (
    left.version === right.version &&
    left.channel === right.channel &&
    left.runNumber === right.runNumber &&
    left.sha === right.sha
  );
}
/** The file in every deployed site that names the build it came from. */
const docsBuildFile = "drfed-docs-build.json";
function docsSiteUrl(): URL {
  const value = process.env.DRFED_DOCS_URL;
  assert.ok(value, "DRFED_DOCS_URL is required to check the deployed docs");
  const url = new URL(value);
  if (fixture) {
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
  } else assert.equal(url.protocol, "https:");
  return url;
}
async function servedDocsBuild(
  environment: string,
): Promise<DocsRecord | null> {
  const url = new URL(docsBuildFile, docsSiteUrl());
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { "Cache-Control": "no-cache" },
      });
    } catch (error) {
      if (attempt === 2) throw error;
      await delay(fixture ? 1 : 1000 * (attempt + 1));
      continue;
    }
    // A site deployed before builds named themselves has no such file.
    if (response.status === 404) return null;
    if (response.ok) {
      return parseDocsRecord(
        await response.text(),
        environment,
        `Malformed ${url.href}`,
      );
    }
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      await delay(fixture ? 1 : 1000 * (attempt + 1));
      continue;
    }
    throw new Error(`GET ${url.href}: HTTP ${response.status}`);
  }
  throw new Error("Unreachable request state");
}
async function postDocsStatus(
  id: number,
  build: Version,
  state: string,
  environmentUrl?: string,
): Promise<void> {
  // Earlier records keep their success state, so marking the newest record
  // otherwise falls back to the previous deployment instead of to none.
  const status = (await githubPost(
    `repos/${repository}/deployments/${id}/statuses`,
    {
      state,
      log_url: `https://github.com/${repository}/actions/runs/${build.runId}`,
      auto_inactive: false,
      ...(environmentUrl ? { environment_url: environmentUrl } : {}),
    },
  )) as Partial<GitHubDeploymentStatus>;
  assert.equal(status.state, state);
}
async function servedDocsDeployment(
  environment: string,
  build: Version,
): Promise<DocsRecord | null> {
  // GitHub does not document the order of either listing, so read every
  // deployment and status and order them by their increasing identifiers.
  const deployments = (
    await githubList<GitHubDeployment>(`repos/${repository}/deployments`, {
      environment,
    })
  ).toSorted((left, right) => githubId(right.id) - githubId(left.id));
  let served: DocsRecord | null | undefined;
  for (const deployment of deployments) {
    assert.equal(deployment.environment, environment);
    const statuses = await githubList<GitHubDeploymentStatus>(
      `repos/${repository}/deployments/${deployment.id}/statuses`,
    );
    const newest = statuses.reduce<GitHubDeploymentStatus | null>(
      (latest, item) =>
        latest === null || githubId(item.id) > latest.id ? item : latest,
      null,
    );
    if (newest?.state === "success") {
      return docsRecord(deployment, environment);
    }
    if (newest?.state === "inactive") continue;
    // Any other state is an intent whose upload may or may not have reached
    // the site, so the site itself settles it.  Jobs for one site run one at
    // a time, so no upload is still in flight here.
    const record = docsRecord(deployment, environment);
    served ??= await servedDocsBuild(environment);
    if (served !== null && sameDocsRecord(served, record)) {
      await postDocsStatus(deployment.id, build, "success");
      console.log(
        `Docs deployment ${deployment.id} (${record.version}) is being served; recorded it as successful.`,
      );
      return record;
    }
    await postDocsStatus(deployment.id, build, "inactive");
    console.log(
      `Docs deployment ${deployment.id} (${record.version}) is not being served; marked it inactive.`,
    );
  }
  return null;
}
async function docsCurrent(): Promise<void> {
  const build = buildFromEnvironment();
  requireGitHubToken();
  // A queued tag run must not deploy after its tag was deleted or moved.
  await tagTarget(build);
  const environment = docsEnvironment(build);
  const last = await servedDocsDeployment(environment, build);
  let current = true;
  if (last !== null) {
    const order =
      build.channel === "dev"
        ? BigInt(build.runNumber) - BigInt(last.runNumber)
        : BigInt(compare(build.version, last.version));
    if (order === 0n) {
      assert.equal(last.sha, build.sha, "Same docs build from another commit");
    }
    current = order >= 0n;
  }
  if (current) {
    console.log(
      last === null
        ? `No successful ${environment} deployment yet; deploying ${build.version}.`
        : `Last ${environment} deployment is ${last.version}; deploying ${build.version}.`,
    );
  } else {
    // A skip is intended (SemVer orders latest and next together, so a stable
    // patch after a higher prerelease is skipped), but it should be noticed.
    console.log(
      `::warning title=Docs deployment skipped::Skipped docs ${build.version} (run ${build.runNumber}) because ${environment} already serves ${last!.version} (run ${last!.runNumber}, ${last!.sha}).`,
    );
  }
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `current=${current}\n`);
  }
}
// Whether a failed `gh api` call is worth retrying.
function transientGhFailure(error: unknown): boolean {
  const { code, killed, stderr } = error as {
    code?: unknown;
    killed?: boolean;
    stderr?: unknown;
  };
  // The gh CLI reports an HTTP error as "message (HTTP status)" on stderr.
  const status =
    typeof stderr === "string"
      ? /\(HTTP (?<status>\d{3})\)/u.exec(stderr)?.groups?.status
      : undefined;
  if (status != null) return status === "429" || status.startsWith("5");
  // Without a response, a timeout or gh's generic exit status 1 is a network
  // failure, while a missing login (status 4) or a spawn error such as ENOENT
  // is not going to resolve itself.
  return killed === true || code === 1;
}
async function githubPost(path: string, body: unknown): Promise<unknown> {
  // Writes go through gh like the GitHub Release path, so the same token
  // handling applies and fixtures intercept them with the same stub.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pending = execute(
      "gh",
      ["api", "--method", "POST", path, "--input", "-"],
      { cwd: root, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
    );
    pending.child.stdin?.end(JSON.stringify(body));
    let stdout: string;
    try {
      ({ stdout } = await pending);
    } catch (error) {
      if (attempt === 2 || !transientGhFailure(error)) throw error;
      await delay(fixture ? 1 : 1000 * (attempt + 1));
      continue;
    }
    return JSON.parse(stdout) as unknown;
  }
  throw new Error("Unreachable request state");
}
async function docsIntent(): Promise<void> {
  const build = buildFromEnvironment();
  requireGitHubToken();
  // The docs:record-intent task declares its argument with `usage`, so mise
  // passes it as usage_dir instead of appending it to the command.
  const dist = process.env.usage_dir;
  assert.ok(dist, "Missing the docs build directory");
  const environment = docsEnvironment(build);
  const payload: DocsRecord = {
    version: build.version,
    channel: build.channel,
    runNumber: build.runNumber,
    sha: build.sha,
  };
  // The site names its build so that an intent left unresolved by a failed
  // job can be settled against what is actually served.
  await writeFile(join(resolve(dist), docsBuildFile), JSON.stringify(payload));
  // The commit, not the tag or branch name, is what was deployed; a ref name
  // could be resolved after it has moved. Required contexts are left empty
  // because the workflow has already gated the deployment on its own jobs.
  // Retrying either POST is safe: a deployment that a failed attempt created
  // anyway is an intent that nothing uploaded, so the next check marks it
  // inactive.
  const deployment = (await githubPost(`repos/${repository}/deployments`, {
    ref: build.sha,
    task: "deploy",
    auto_merge: false,
    required_contexts: [],
    environment,
    payload,
    description: `Documentation ${build.version}`,
    transient_environment: false,
    production_environment: true,
  })) as Partial<GitHubDeployment>;
  const id = githubId(deployment.id);
  assert.equal(deployment.sha, build.sha);
  await postDocsStatus(id, build, "in_progress");
  console.log(
    `Recorded the intent to deploy ${build.version} (${build.sha}) to ${environment} as deployment ${id}`,
  );
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `deployment=${id}\n`);
  }
}
async function docsRecordDeployment(): Promise<void> {
  const build = buildFromEnvironment();
  requireGitHubToken();
  const id = githubId(Number(process.env.DOCS_DEPLOYMENT_ID));
  // A repeated success status leaves that deployment's newest status a
  // success, so the status is retried against the same deployment.
  await postDocsStatus(id, build, "success", process.env.DRFED_DOCS_URL);
  console.log(
    `Recorded ${docsEnvironment(build)} deployment ${id} for ${build.version} (${build.sha})`,
  );
}
if (command === "version") {
  const build = await calculate();
  console.log(JSON.stringify(build));
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `enabled=${build.enabled}\nbuild=${JSON.stringify(build)}\n`,
    );
  }
} else if (command === "apply") await apply();
else if (command === "ensure-unpublished") await ensureUnpublished();
else if (command === "tag-target") await tagTarget(buildFromEnvironment());
else if (command === "pack") await pack();
else if (command === "verify") {
  await verify();
  console.log("Verified release artifact identities and contents");
} else if (command === "publish") await publish();
else if (command === "github-release") await release();
else if (command === "image-index") await imageIndex();
else if (command === "image-push") await imagePush();
else if (command === "image-tags") await imageTags();
else if (command === "image-attestation") {
  // The task declares its argument with `usage`, so mise passes it as
  // usage_action; fixtures pass it directly.
  await imageAttestation(
    cliArgs[0]?.startsWith("--") === false
      ? cliArgs[0]
      : process.env.usage_action,
  );
} else if (command === "docs-current") await docsCurrent();
else if (command === "docs-intent") await docsIntent();
else if (command === "docs-record") await docsRecordDeployment();
else if (command === "compare") {
  console.log(compare(cliArgs[0]!, cliArgs[1]!));
} else {
  throw new Error(
    "Expected version, apply, ensure-unpublished, tag-target, pack, verify, publish, github-release, image-index, image-push, image-tags, image-attestation, docs-current, docs-intent, docs-record or compare",
  );
}
