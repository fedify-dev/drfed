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
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("./release.mts", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "drfed-release-fixture-"));
const root = join(temporary, "repo");
const archives = join(root, "release-artifacts");
const names = ["models", "federation", "graphql", "web", "drfed"];
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(?:ACTIONS_|NPM_|NODE_AUTH_TOKEN|GH_TOKEN|GITHUB_|GIT_|npm_config_)/u.test(
        key,
      ),
  ),
);
const documents = new Map<string, Record<string, unknown>>();
const tags = new Map<string, Record<string, string>>();
const visibilityMisses = new Map<string, number>();
const tagVisibility = new Map<
  string,
  { tags: Record<string, string>; remaining: number }
>();
const operations: string[][] = [];
let readFailures = 0;
let status = 0;
let publishFailure = "";
let publishFailureName = "";
let publishVisibilityMisses = 0;
let publishTagVisibilityMisses = 0;
let tagVisibilityMisses = 0;
let githubRelease:
  | {
      tag_name: string;
      body: string;
      draft: boolean;
      prerelease: boolean;
      assets: { name: string; size: number; digest?: string; state: string }[];
    }
  | undefined;
const githubOperations: string[][] = [];
interface FixtureDeployment {
  id: number;
  sha: string;
  environment: string;
  payload: unknown;
  statuses: { id: number; state: string }[];
}
// Deployments are served oldest first, the reverse of GitHub's observed order,
// so that the fixtures prove the ordering does not depend on the listing.
const deployments: FixtureDeployment[] = [];
const deploymentRequests: Record<string, unknown>[] = [];
const deploymentPages: string[] = [];
// The first queued failure whose path matches answers a `gh api` POST in
// place of the handler, and is consumed by it.
const githubPostFailures: { path: RegExp; status: number }[] = [];
let githubId = 0;
let githubStatus = 0;
// What the deployed docs site names as its build: a record, raw text, or
// nothing (404).  A nonzero status answers in its place.
let servedDocs: unknown;
let servedDocsStatus = 0;
function handleServedDocs(
  path: string,
  response: import("node:http").ServerResponse,
): boolean {
  if (path !== "/__site/drfed-docs-build.json") return false;
  if (servedDocsStatus || servedDocs === undefined) {
    response.writeHead(servedDocsStatus || 404);
    response.end();
    return true;
  }
  response.setHeader("content-type", "application/json");
  response.end(
    typeof servedDocs === "string" ? servedDocs : JSON.stringify(servedDocs),
  );
  return true;
}
function seedDeployment(
  environment: string,
  payload: unknown,
  states: string[],
  sha?: string,
): FixtureDeployment {
  githubId += 1;
  const deployment: FixtureDeployment = {
    id: githubId,
    sha: sha ?? (payload as { sha?: string } | null)?.sha ?? "0".repeat(40),
    environment,
    payload,
    statuses: [],
  };
  for (const state of states) {
    githubId += 1;
    deployment.statuses.push({ id: githubId, state });
  }
  deployments.push(deployment);
  return deployment;
}
function handleGitHubApi(
  args: string[],
  input: Record<string, unknown>,
): unknown {
  deploymentRequests.push({ args, input });
  const statuses =
    /^repos\/fedify-dev\/drfed\/deployments\/(?<id>\d+)\/statuses$/u.exec(
      args[3]!,
    );
  if (statuses) {
    const deployment = deployments.find(
      (item) => item.id === Number(statuses.groups!.id),
    );
    if (!deployment) return null;
    githubId += 1;
    const created = { id: githubId, state: input.state as string };
    deployment.statuses.push(created);
    return created;
  }
  if (args[3] !== "repos/fedify-dev/drfed/deployments") return null;
  githubId += 1;
  const deployment: FixtureDeployment = {
    id: githubId,
    sha: input.ref as string,
    environment: input.environment as string,
    payload: input.payload,
    statuses: [],
  };
  deployments.push(deployment);
  return deployment;
}
function respondGitHubApi(
  args: string[],
  input: Record<string, unknown>,
  response: import("node:http").ServerResponse,
): void {
  response.setHeader("content-type", "application/json");
  const index = githubPostFailures.findIndex((item) =>
    item.path.test(args[3]!),
  );
  if (index >= 0) {
    const failure = githubPostFailures.splice(index, 1)[0]!.status;
    deploymentRequests.push({ args, input, failure });
    response.writeHead(failure);
    response.end('{"message":"Fixture failure"}');
    return;
  }
  const result = handleGitHubApi(args, input);
  if (result === null) response.writeHead(404);
  response.end(JSON.stringify(result ?? {}));
}
function githubPage<T>(items: T[], url: URL): T[] {
  const size = Number(url.searchParams.get("per_page") ?? "30");
  const page = Number(url.searchParams.get("page") ?? "1");
  return items.slice((page - 1) * size, page * size);
}
function handleDeploymentRead(
  path: string,
  url: URL,
  response: import("node:http").ServerResponse,
): boolean {
  const prefix = "/repos/fedify-dev/drfed/deployments";
  if (!path.startsWith(prefix)) return false;
  response.setHeader("content-type", "application/json");
  if (githubStatus) {
    response.writeHead(githubStatus);
    response.end("{}");
    return true;
  }
  if (path === prefix) {
    const environment = url.searchParams.get("environment");
    deploymentPages.push(url.search);
    const matching = deployments.filter(
      (item) => environment === null || item.environment === environment,
    );
    response.end(
      JSON.stringify(
        githubPage(matching, url).map((item) => ({
          id: item.id,
          sha: item.sha,
          environment: item.environment,
          payload: item.payload,
        })),
      ),
    );
    return true;
  }
  const match = /^\/(?<id>\d+)\/statuses$/u.exec(path.slice(prefix.length));
  const deployment = deployments.find(
    (item) => item.id === Number(match?.groups?.id),
  );
  if (!deployment) {
    response.writeHead(404);
    response.end("{}");
    return true;
  }
  response.end(JSON.stringify(githubPage(deployment.statuses, url)));
  return true;
}
let putDocument:
  | {
      versions: Record<
        string,
        {
          version: string;
          drfedBuild: { sha: string; fullVersion: string };
          dist: { integrity: string };
        }
      >;
    }
  | undefined;
function handleNpm(
  bytes: Buffer,
  response: import("node:http").ServerResponse,
): void {
  const operation = JSON.parse(bytes.toString()) as {
    args: string[];
    manifest?: Record<string, unknown>;
    integrity?: string;
  };
  operations.push(operation.args);
  const [command, target, ...rest] = operation.args;
  if (command === "publish") {
    const manifest = operation.manifest!;
    const name = manifest.name as string;
    if (
      publishFailure &&
      (!publishFailureName || publishFailureName === name)
    ) {
      response.writeHead(500);
      response.end(publishFailure);
      return;
    }
    const key = `${name}/${manifest.version}`;
    if (documents.has(key)) {
      response.writeHead(409);
      response.end("E403 immutable version");
      return;
    }
    visibilityMisses.set(key, publishVisibilityMisses);
    documents.set(key, {
      ...manifest,
      dist: { integrity: operation.integrity },
    });
    const previous = { ...tags.get(name) };
    tags.set(name, {
      ...previous,
      [rest[rest.indexOf("--tag") + 1]!]: manifest.version as string,
    });
    tagVisibility.set(name, {
      tags: previous,
      remaining: publishTagVisibilityMisses,
    });
  } else if (command === "dist-tag") {
    const action = target;
    const spec = rest[0]!;
    const tag = rest[1]!;
    if (action === "add") {
      const index = spec.lastIndexOf("@");
      const name = spec.slice(0, index);
      const previous = { ...tags.get(name) };
      tags.set(name, { ...previous, [tag]: spec.slice(index + 1) });
      tagVisibility.set(name, {
        tags: previous,
        remaining: tagVisibilityMisses,
      });
    } else {
      if (!visibleTags(spec)?.[tag]) {
        response.writeHead(404);
        response.end(`${tag} is not a dist-tag on ${spec}`);
        return;
      }
      const current = tags.get(spec)!;
      delete current[tag];
    }
  }
  response.end("{}");
}
function visibleTags(name: string): Record<string, string> | undefined {
  const stale = tagVisibility.get(name);
  if (stale && stale.remaining > 0) {
    stale.remaining -= 1;
    return stale.tags;
  }
  return tags.get(name);
}
const registryReadCache = new Map<string, unknown>();
function registryDocument(path: string, fresh: boolean): unknown {
  if (!fresh && registryReadCache.has(path)) return registryReadCache.get(path);
  const key = path.slice(1);
  const misses = visibilityMisses.get(key) ?? 0;
  let document: unknown;
  if (misses > 0) {
    visibilityMisses.set(key, misses - 1);
    document = null;
  } else {
    const tagPrefix = "/-/package/";
    document = path.startsWith(tagPrefix)
      ? visibleTags(path.slice(tagPrefix.length, -"/dist-tags".length))
      : documents.get(key);
  }
  if (!fresh) registryReadCache.set(path, structuredClone(document ?? null));
  return document;
}
const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = decodeURIComponent(requestUrl.pathname);
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  if (request.method === "PUT") {
    putDocument = JSON.parse(bytes.toString());
    response.writeHead(201);
    response.end("{}");
    return;
  }
  if (path === "/__gh") {
    const operation = JSON.parse(bytes.toString()) as {
      args: string[];
      input?: Record<string, unknown>;
      notes?: string;
      asset?: { name: string; size: number; digest: string };
    };
    if (operation.args[0] === "api") {
      respondGitHubApi(operation.args, operation.input!, response);
      return;
    }
    githubOperations.push(operation.args);
    if (operation.args[1] === "create") {
      githubRelease = {
        tag_name: operation.args[2]!,
        body: operation.notes!,
        draft: false,
        prerelease: operation.args.includes("--prerelease"),
        assets: [],
      };
    } else {
      if (operation.args.includes("--clobber")) {
        githubRelease!.assets = githubRelease!.assets.filter(
          (item) => item.name !== operation.asset!.name,
        );
      }
      githubRelease!.assets.push({ ...operation.asset!, state: "uploaded" });
    }
    response.end("{}");
    return;
  }
  if (path.startsWith("/repos/fedify-dev/drfed/releases/tags/")) {
    if (!githubRelease) {
      response.writeHead(404);
      response.end("{}");
    } else {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(githubRelease));
    }
    return;
  }
  if (handleDeploymentRead(path, requestUrl, response)) return;
  if (handleServedDocs(path, response)) return;
  if (path === "/__npm") {
    handleNpm(bytes, response);
    return;
  }
  if (status || readFailures > 0) {
    if (readFailures > 0) readFailures -= 1;
    response.writeHead(status || 503);
    response.end("{}");
    return;
  }
  const document = registryDocument(
    path,
    requestUrl.searchParams.get("write") === "true" &&
      request.headers["cache-control"] === "no-cache",
  );
  if (!document) {
    response.writeHead(404);
    response.end("{}");
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(document));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const registry = `http://127.0.0.1:${address.port}/`;
async function run(args: string[], overrides: Record<string, string> = {}) {
  return await execute(
    process.execPath,
    [
      script,
      ...args,
      "--root",
      root,
      "--artifacts",
      archives,
      "--fixture",
      "--registry",
      registry,
      "--remote",
      root,
    ],
    {
      cwd: root,
      env: { ...env, ...overrides },
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}
async function git(...args: string[]) {
  return await execute("git", args, { cwd: root, env, timeout: 30_000 });
}
async function writeImageManifest(): Promise<void> {
  // The image-index step writes this; GitHub Releases attach it.
  const current = JSON.parse(
    await readFile(join(archives, "manifest.json"), "utf8"),
  );
  const directory = join(root, "image-artifacts", "index");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "image-manifest.json"),
    `${JSON.stringify({ digest: `sha256:${"a".repeat(64)}`, build: current.build, packages: current.packages }, null, 2)}\n`,
  );
}
function integrity(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
try {
  await mkdir(root);
  const gitConfig = join(temporary, "gitconfig");
  await writeFile(gitConfig, "");
  env.GIT_CONFIG_GLOBAL = gitConfig;
  env.GIT_CONFIG_NOSYSTEM = "1";
  await writeFile(join(root, "package.json"), '{"private":true}');
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n",
  );
  for (const name of names) {
    const path = join(root, "packages", name);
    await mkdir(join(path, "dist"), { recursive: true });
    await writeFile(join(path, "dist/index.mjs"), "export {};\n");
    await writeFile(join(path, "dist/index.d.mts"), "export {};\n");
    await writeFile(
      join(path, "package.json"),
      JSON.stringify({
        name: `@drfed/${name}`,
        version: "0.1.0",
        main: "dist/index.mjs",
        types: "dist/index.d.mts",
        repository: {
          type: "git",
          url: "https://github.com/fedify-dev/drfed.git",
          directory: `packages/${name}`,
        },
        publishConfig: { access: "public" },
        dependencies:
          name === "models" ? {} : { "@drfed/models": "workspace:*" },
      }),
    );
  }
  await mkdir(join(root, "packages/models/drizzle/0000"), { recursive: true });
  await writeFile(
    join(root, "packages/models/drizzle/0000/migration.sql"),
    "select 1;",
  );
  await writeFile(
    join(root, "packages/models/dist/migrations-manifest.json"),
    "[]",
  );
  await mkdir(join(root, "packages/web/.output/server"), { recursive: true });
  await writeFile(
    join(root, "packages/web/.output/server/index.mjs"),
    "export {};",
  );
  await mkdir(join(root, "packages/drfed/bin"));
  for (const name of ["server", "web", "migrate", "account"]) {
    await writeFile(
      join(root, `packages/drfed/bin/drfed-${name}.mjs`),
      "export {};",
    );
  }
  const completionNames: string[] = [];
  for (const commandName of ["server", "web", "migrate", "account"]) {
    const command = `drfed-${commandName}`;
    for (const shell of ["bash", "zsh", "fish", "pwsh", "nu"]) {
      const name =
        shell === "zsh"
          ? `_${command}`
          : shell === "fish"
            ? `${command}.fish`
            : shell === "pwsh"
              ? `${command}.ps1`
              : shell === "nu"
                ? `${command}.nu`
                : command;
      const directory = join(root, "packages/drfed/completions", shell);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, name),
        `# ${command} ${shell} completion\n`,
      );
      completionNames.push(`${command}.${shell}`);
    }
  }
  await git("init", "-q");
  await git("config", "user.email", "fixture@example.invalid");
  await git("config", "user.name", "Fixture");
  await git("add", ".");
  await git("commit", "-qm", "Fixture");
  const sha = (await git("rev-parse", "HEAD")).stdout.trim();
  Object.assign(env, {
    GITHUB_EVENT_NAME: "push",
    GITHUB_REPOSITORY: "fedify-dev/drfed",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: sha,
    GITHUB_RUN_NUMBER: "123",
    GITHUB_RUN_ID: "456",
  });
  const build = JSON.parse((await run(["version"])).stdout);
  assert.equal(build.version, "0.1.0-dev.123");
  assert.equal(build.fullVersion, `0.1.0-dev.123+${sha.slice(0, 8)}`);
  assert.deepEqual(JSON.parse((await run(["version"])).stdout), build);
  for (const overrides of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REPOSITORY: "someone/drfed" },
    { GITHUB_REF: "refs/heads/other" },
  ]) {
    assert.equal(
      JSON.parse((await run(["version"], overrides)).stdout).enabled,
      false,
    );
  }
  const event = join(temporary, "event.json");
  await writeFile(event, '{"deleted":true}');
  assert.equal(
    JSON.parse((await run(["version"], { GITHUB_EVENT_PATH: event })).stdout)
      .enabled,
    false,
  );
  for (const tag of ["v0.1.0", "01.1.0", "0.1.0-01", "0.1.0+sha", "0.2.0"]) {
    await assert.rejects(run(["version"], { GITHUB_REF: `refs/tags/${tag}` }));
  }
  assert.equal(
    JSON.parse(
      (await run(["version"], { GITHUB_REF: "refs/tags/0.1.0" })).stdout,
    ).channel,
    "latest",
  );
  for (const [left, right, result] of [
    ["0.1.0-dev.124", "0.1.0-dev.123", 1],
    ["0.2.0-dev.1", "0.1.0-dev.500", 1],
    ["0.1.0-rc.2", "0.1.0-rc.10", -1],
    ["0.1.0", "0.1.0-rc.1", 1],
    ["0.1.0", "0.1.0", 0],
  ] as const) {
    assert.equal(Number((await run(["compare", left, right])).stdout), result);
  }
  const mismatched = join(root, "packages/web/package.json");
  const original = await readFile(mismatched, "utf8");
  await writeFile(mismatched, original.replace('"0.1.0"', '"0.2.0"'));
  await assert.rejects(
    run(["apply"], { DRFED_RELEASE_BUILD: JSON.stringify(build) }),
  );
  assert.equal(
    JSON.parse(
      await readFile(join(root, "packages/models/package.json"), "utf8"),
    ).version,
    "0.1.0",
  );
  await writeFile(mismatched, original);
  for (const name of names.filter((candidate) => candidate !== "models")) {
    const scope = join(root, "packages", name, "node_modules/@drfed");
    await mkdir(scope, { recursive: true });
    await symlink(join(root, "packages/models"), join(scope, "models"), "dir");
  }
  const tagBuild = {
    ...build,
    version: "0.1.0",
    fullVersion: "0.1.0",
    channel: "latest",
    ref: "refs/tags/0.1.0",
  };
  const tagEnv = {
    DRFED_RELEASE_BUILD: JSON.stringify(tagBuild),
    GITHUB_REF: tagBuild.ref,
  };
  await git("tag", "0.1.0", sha);
  await run(["tag-target"], tagEnv);
  await git("tag", "-d", "0.1.0");
  await assert.rejects(run(["tag-target"], tagEnv));
  await git("tag", "-a", "0.1.0", "-m", "Annotated fixture", sha);
  await run(["tag-target"], tagEnv);
  await git("commit", "--allow-empty", "-qm", "Retarget fixture");
  await git("tag", "-f", "0.1.0");
  await assert.rejects(run(["tag-target"], tagEnv));
  await git("checkout", "--detach", sha);
  await git("tag", "-d", "0.1.0");
  const originals = await Promise.all(
    names.map((name) =>
      readFile(join(root, "packages", name, "package.json"), "utf8"),
    ),
  );
  for (const [index, name] of names.entries()) {
    await writeFile(
      join(root, "packages", name, "package.json"),
      originals[index]!.replace('"0.1.0"', '"0.1.0-rc.1"'),
    );
  }
  assert.equal(
    JSON.parse(
      (await run(["version"], { GITHUB_REF: "refs/tags/0.1.0-rc.1" })).stdout,
    ).channel,
    "next",
  );
  for (const [index, name] of names.entries()) {
    await writeFile(
      join(root, "packages", name, "package.json"),
      originals[index]!,
    );
  }
  env.DRFED_RELEASE_BUILD = JSON.stringify(build);
  await run(["ensure-unpublished"]);
  await run(["apply"]);
  await run(["pack"]);
  await run(["verify"]);
  const bundle = JSON.parse(
    await readFile(join(archives, "manifest.json"), "utf8"),
  );
  // A stub npm lets the real publisher exercise registry and failure behavior.
  const bin = join(temporary, "bin");
  await mkdir(bin);
  const stub = `#!/usr/bin/env node\nimport {readFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';const args=process.argv.slice(2);const body={args};if(args[0]==='publish'){body.manifest=JSON.parse(execFileSync('tar',['-xOf',args[1],'package/package.json'],{encoding:'utf8'}));body.integrity='sha512-'+createHash('sha512').update(readFileSync(args[1])).digest('base64');}const response=await fetch('${registry}__npm',{method:'POST',body:JSON.stringify(body)});if(!response.ok){console.error(await response.text());process.exitCode=1;}\n`;
  await writeFile(join(bin, "npm"), stub, { mode: 0o755 });
  env.PATH = `${bin}${delimiter}${env.PATH}`;
  publishFailure = "E503 fixture failure";
  await assert.rejects(run(["publish"]));
  assert.equal(operations.length, 3);
  assert.equal(documents.size, 0);
  operations.length = 0;
  publishFailure = "";
  // Recover an existing dependency, then publish its consumers in order.
  const first = bundle.packages[0];
  const manifest = JSON.parse(
    (
      await execute("tar", [
        "-xOf",
        join(archives, first.filename),
        "package/package.json",
      ])
    ).stdout,
  );
  documents.set(`${first.name}/${build.version}`, {
    ...manifest,
    dist: { integrity: first.integrity },
  });
  const bootstrapVersion = `${build.baseVersion}-dev.0`;
  const bootstrapManifest = { ...manifest, version: bootstrapVersion };
  delete bootstrapManifest.drfedBuild;
  documents.set(`${first.name}/${bootstrapVersion}`, bootstrapManifest);
  tags.set(first.name, { latest: "0.0.0", dev: bootstrapVersion });
  readFailures = 2;
  publishFailure = "E503 fixture failure";
  publishFailureName = "@drfed/graphql";
  await assert.rejects(run(["publish"]));
  assert.ok(documents.has(`@drfed/federation/${build.version}`));
  assert.equal(tags.get(first.name)!.dev, bootstrapVersion);
  publishFailure = "";
  publishFailureName = "";
  operations.length = 0;
  await run(["publish"]);
  assert.deepEqual(
    operations
      .filter((item) => item[0] === "publish")
      .map((item) => item[1]!.split("/").at(-1)),
    bundle.packages.slice(2).map((item: { filename: string }) => item.filename),
  );
  for (const name of names) {
    assert.equal(tags.get(`@drfed/${name}`)?.dev, build.version);
    assert.equal(tags.get(`@drfed/${name}`)?.["dev-staging"], undefined);
  }
  assert.equal(tags.get(first.name)?.latest, "0.0.0");
  operations.length = 0;
  await run(["publish"]);
  assert.equal(operations.length, 0);
  // The bootstrap exception must not admit other unmanaged or malformed builds.
  for (const version of ["0.2.0-dev.0", `${build.baseVersion}-dev.1`]) {
    documents.set(`${first.name}/${version}`, { name: first.name, version });
    tags.get(first.name)!.dev = version;
    await assert.rejects(run(["publish"]), /Cannot order a foreign dev build/u);
    assert.equal(operations.length, 0);
  }
  documents.set(`${first.name}/${bootstrapVersion}`, {
    ...bootstrapManifest,
    drfedBuild: {},
  });
  tags.get(first.name)!.dev = bootstrapVersion;
  await assert.rejects(run(["publish"]), /Cannot order a foreign dev build/u);
  assert.equal(operations.length, 0);
  tags.get(first.name)!.dev = build.version;
  // Successful tag writes do not need immediate registry visibility.
  documents.set(`${first.name}/${bootstrapVersion}`, bootstrapManifest);
  tags.get(first.name)!.dev = bootstrapVersion;
  tagVisibilityMisses = Number.POSITIVE_INFINITY;
  await run(["publish"]);
  assert.equal(operations.length, 1);
  assert.equal(operations[0]![0], "dist-tag");
  assert.equal(operations[0]![1], "add");
  tagVisibility.delete(first.name);
  tagVisibilityMisses = 0;
  operations.length = 0;
  await run(["publish"]);
  assert.equal(operations.length, 0);
  // Successful uploads are accepted even while version reads remain hidden.
  const hiddenKey = `${first.name}/${build.version}`;
  documents.delete(hiddenKey);
  publishVisibilityMisses = Number.POSITIVE_INFINITY;
  publishTagVisibilityMisses = Number.POSITIVE_INFINITY;
  await run(["publish"]);
  assert.equal(operations.filter((item) => item[0] === "publish").length, 1);
  assert.equal(visibilityMisses.get(hiddenKey), Number.POSITIVE_INFINITY);
  assert.equal(tags.get(first.name)?.["dev-staging"], build.version);
  visibilityMisses.delete(hiddenKey);
  publishVisibilityMisses = 0;
  publishTagVisibilityMisses = 0;
  tagVisibility.delete(first.name);
  operations.length = 0;
  await run(["publish"]);
  assert.equal(operations.filter((item) => item[0] === "publish").length, 0);
  assert.equal(tags.get(first.name)?.["dev-staging"], undefined);
  operations.length = 0;
  // A retry can encounter an immutable version before its metadata is visible.
  visibilityMisses.set(hiddenKey, 8);
  await run(["publish"]);
  assert.equal(operations.filter((item) => item[0] === "publish").length, 1);
  operations.length = 0;
  const existingDocument = documents.get(hiddenKey)!;
  documents.set(hiddenKey, {
    ...existingDocument,
    dist: { integrity: "sha512-conflicting-artifact" },
  });
  visibilityMisses.set(hiddenKey, 8);
  await assert.rejects(run(["publish"]), /Immutable version conflict/u);
  assert.equal(operations.filter((item) => item[0] === "publish").length, 1);
  documents.set(hiddenKey, existingDocument);
  operations.length = 0;
  // A newer main run remains newest after a base-version rollback.
  for (const name of names) {
    const currentVersion = "0.2.0-dev.122";
    tags.get(`@drfed/${name}`)!.dev = currentVersion;
    documents.set(`@drfed/${name}/${currentVersion}`, {
      name: `@drfed/${name}`,
      version: currentVersion,
      drfedBuild: {
        ...build,
        version: currentVersion,
        fullVersion: `${currentVersion}+bbbbbbbb`,
        baseVersion: "0.2.0",
        sha: "b".repeat(40),
        runNumber: "122",
        runId: "455",
      },
    });
  }
  await run(["publish"]);
  for (const name of names) {
    assert.equal(tags.get(`@drfed/${name}`)!.dev, build.version);
  }
  operations.length = 0;
  for (const name of names) {
    const currentVersion = "0.1.0-dev.999";
    tags.get(`@drfed/${name}`)!.dev = currentVersion;
    documents.set(`@drfed/${name}/${currentVersion}`, {
      name: `@drfed/${name}`,
      version: currentVersion,
      drfedBuild: {
        ...build,
        version: currentVersion,
        fullVersion: `${currentVersion}+cccccccc`,
        sha: "c".repeat(40),
        runNumber: "999",
        runId: "999",
      },
    });
  }
  await run(["publish"]);
  assert.equal(operations.length, 0);
  documents.get(`${first.name}/${build.version}`)!.dist = {
    integrity: "sha512-conflict",
  };
  await assert.rejects(run(["publish"]));
  assert.equal(operations.length, 0);
  documents.get(`${first.name}/${build.version}`)!.dist = {
    integrity: first.integrity,
  };
  documents.get(`${first.name}/${build.version}`)!.drfedBuild = {
    ...build,
    sha: "a".repeat(40),
  };
  await assert.rejects(run(["publish"]));
  assert.equal(operations.length, 0);
  documents.get(`${first.name}/${build.version}`)!.drfedBuild = build;
  status = 401;
  await assert.rejects(run(["publish"]));
  assert.equal(operations.length, 0);
  status = 0;
  const tarball = join(archives, first.filename);
  const bytes = await readFile(tarball);
  await writeFile(tarball, Buffer.concat([bytes, Buffer.from("tampered")]));
  await assert.rejects(run(["verify"]));
  await writeFile(tarball, bytes);
  // Frozen tag notes, GitHub Release reruns and exact matching assets.
  for (const name of names) {
    const path = join(root, "packages", name, "package.json");
    const restoredManifest = JSON.parse(await readFile(path, "utf8"));
    restoredManifest.version = "0.1.0";
    delete restoredManifest.drfedBuild;
    await writeFile(path, JSON.stringify(restoredManifest));
  }
  await assert.rejects(run(["ensure-unpublished"]));
  Object.assign(env, tagEnv);
  await git("tag", "0.1.0", sha);
  await run(["apply"]);
  await mkdir(join(root, "changes.d"));
  await writeFile(
    join(root, "sacho.toml"),
    '[changelog]\npath = "CHANGES.md"\ntitle = "Fixture"\nmaterialize = false\n[fragments]\ndirectory = "changes.d"\nnext-file = "next"\n',
  );
  await writeFile(join(root, "CHANGES.md"), "Fixture\n=======\n");
  await writeFile(
    join(root, "changes.d/tag.md"),
    " -  Frozen fixture notes.\n",
  );
  const sacho = (await execute("mise", ["which", "sacho"])).stdout.trim();
  await execute(sacho, ["fmt"], { cwd: root, env });
  await execute(sacho, ["release", "0.1.0", "--date", "2026-10-12"], {
    cwd: root,
    env,
  });
  await run(["pack"]);
  documents.clear();
  tags.clear();
  operations.length = 0;
  await run(["publish"]);
  await writeImageManifest();
  const ghStub = `#!/usr/bin/env node\nimport {readFileSync} from 'node:fs';import {basename} from 'node:path';import {createHash} from 'node:crypto';const args=process.argv.slice(2);const body={args};if(args[0]==='api')body.input=JSON.parse(readFileSync(0,'utf8'));else if(args[1]==='create')body.notes=readFileSync(args[args.indexOf('--notes-file')+1],'utf8');else{const bytes=readFileSync(args[3]);body.asset={name:basename(args[3]),size:bytes.length,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex')};}const response=await fetch('${registry}__gh',{method:'POST',body:JSON.stringify(body)});process.stdout.write(await response.text());if(!response.ok){process.stderr.write('gh: Fixture failure (HTTP '+response.status+')\\n');process.exitCode=1;}\n`;
  await writeFile(join(bin, "gh"), ghStub, { mode: 0o755 });
  // GitHub release creation trusts the successful publish job, even when
  // version metadata is not visible through registry reads yet.
  for (const entry of bundle.packages) {
    visibilityMisses.set(
      `${entry.name}/${tagBuild.version}`,
      Number.POSITIVE_INFINITY,
    );
  }
  await run(["github-release", "--github-api", registry]);
  visibilityMisses.clear();
  assert.equal(githubRelease?.assets.length, 26);
  const createRelease = githubOperations.find((args) => args[1] === "create")!;
  assert.equal(
    createRelease[createRelease.indexOf("--title") + 1],
    `DrFed ${tagBuild.version}`,
  );
  assert.equal(githubOperations.length, 27);
  await run(["github-release", "--github-api", registry]);
  assert.equal(githubOperations.length, 27);
  assert.ok(githubOperations[0]!.includes("--latest=true"));
  // A late backport must preserve npm and GitHub's current Latest release.
  for (const name of names) tags.get(`@drfed/${name}`)!.latest = "0.2.0";
  await run(["publish"]);
  for (const name of names) {
    assert.equal(tags.get(`@drfed/${name}`)!.latest, "0.2.0");
  }
  githubRelease = undefined;
  githubOperations.length = 0;
  await run(["github-release", "--github-api", registry]);
  assert.ok(githubOperations[0]!.includes("--latest=false"));
  assert.equal(githubOperations.length, 27);
  const frozenBody = githubRelease!.body;
  githubRelease!.body = "Different notes";
  await assert.rejects(run(["github-release", "--github-api", registry]));
  githubRelease!.body = frozenBody;
  githubRelease!.prerelease = true;
  await assert.rejects(run(["github-release", "--github-api", registry]));
  githubRelease!.prerelease = false;
  assert.equal(githubOperations.length, 27);
  assert.deepEqual(
    githubRelease!.assets
      .filter((asset) => completionNames.includes(asset.name))
      .map((asset) => asset.name),
    completionNames,
  );
  const completion = join(archives, completionNames[0]!);
  const originalCompletion = await readFile(completion);
  await writeFile(completion, "altered completion");
  await assert.rejects(run(["verify"]));
  const bundlePath = join(archives, "manifest.json");
  const originalBundle = await readFile(bundlePath);
  const alteredBundle = JSON.parse(originalBundle.toString());
  alteredBundle.completions[0].integrity = integrity(
    await readFile(completion),
  );
  await writeFile(bundlePath, JSON.stringify(alteredBundle));
  await assert.rejects(run(["verify"]));
  await writeFile(bundlePath, originalBundle);
  await writeFile(completion, originalCompletion);
  const completeAssets = structuredClone(githubRelease!.assets);
  githubRelease!.assets = completeAssets.slice(0, 2);
  await run(["github-release", "--github-api", registry]);
  assert.equal(githubRelease!.assets.length, 26);
  assert.equal(githubOperations.length, 51);
  githubRelease!.assets[3] = {
    name: completeAssets[3]!.name,
    state: "starter",
    size: 0,
  };
  await run(["github-release", "--github-api", registry]);
  assert.equal(githubRelease!.assets.length, 26);
  assert.equal(githubOperations.length, 52);
  assert.ok(githubOperations.at(-1)!.includes("--clobber"));
  githubRelease!.assets[5]!.digest = "sha256:completion-conflict";
  await assert.rejects(run(["github-release", "--github-api", registry]));
  githubRelease!.assets = structuredClone(completeAssets);
  githubRelease!.assets[0]!.digest = "sha256:conflict";
  await assert.rejects(run(["github-release", "--github-api", registry]));
  assert.equal(githubOperations.length, 52);
  // Docs deployments are ordered against the last build that reached the site.
  const githubOutput = join(temporary, "github-output");
  const devEnv = {
    DRFED_RELEASE_BUILD: JSON.stringify(build),
    GITHUB_REF: build.ref,
  };
  const docsCurrent = async (
    overrides: Record<string, string> = {},
  ): Promise<boolean> => {
    await writeFile(githubOutput, "");
    const { stdout } = await run(["docs-current", "--github-api", registry], {
      DRFED_DOCS_URL: `${registry}__site/`,
      ...overrides,
      GITHUB_OUTPUT: githubOutput,
    });
    const output = await readFile(githubOutput, "utf8");
    assert.match(output, /^current=(?:true|false)\n$/u);
    const current = output === "current=true\n";
    // Every skip is annotated so that maintainers notice it.
    const warnings = stdout
      .split("\n")
      .filter((line) => line.startsWith("::warning "));
    assert.equal(warnings.length, current ? 0 : 1);
    docsWarning = warnings[0];
    return current;
  };
  let docsWarning: string | undefined;
  const devRecord = (runNumber: string, recordSha = sha) => ({
    version: `0.1.0-dev.${runNumber}`,
    channel: "dev",
    runNumber,
    sha: recordSha,
  });
  const releaseRecord = (version: string, recordSha = sha) => ({
    version,
    channel: version.includes("-") ? "next" : "latest",
    runNumber: "100",
    sha: recordSha,
  });
  // An intent names the build in the site; the record settles that intent.
  const docsDist = join(temporary, "docs-dist");
  await mkdir(docsDist, { recursive: true });
  const docsIntent = async (overrides: Record<string, string> = {}) => {
    await writeFile(githubOutput, "");
    // As mise passes the argument of the docs:record-intent task.
    await run(["docs-intent", "--github-api", registry], {
      ...overrides,
      usage_dir: docsDist,
      GITHUB_OUTPUT: githubOutput,
    });
    const output = await readFile(githubOutput, "utf8");
    return /^deployment=(?<id>[1-9]\d*)\n$/u.exec(output)!.groups!.id!;
  };
  const recordDocs = async (overrides: Record<string, string> = {}) => {
    const id = await docsIntent(overrides);
    await run(["docs-record", "--github-api", registry], {
      DRFED_DOCS_URL: "https://drfed.example/",
      ...overrides,
      DOCS_DEPLOYMENT_ID: id,
    });
  };
  // No record yet: the first deployment of either site proceeds.
  assert.equal(await docsCurrent(devEnv), true);
  assert.equal(await docsCurrent(), true);
  assert.ok(deploymentPages.every((query) => query.includes("per_page=100")));
  // Recording creates exactly one deployment of the commit, an in-progress
  // status before the upload, and one success after it.
  await recordDocs();
  assert.deepEqual(
    JSON.parse(await readFile(join(docsDist, "drfed-docs-build.json"), "utf8")),
    { version: "0.1.0", channel: "latest", runNumber: "123", sha },
  );
  assert.equal(deployments.length, 1);
  assert.equal(deploymentRequests.length, 3);
  const [createDeployment, createIntent, createStatus] = deploymentRequests as {
    args: string[];
    input: Record<string, unknown>;
  }[];
  assert.deepEqual(createDeployment!.args, [
    "api",
    "--method",
    "POST",
    "repos/fedify-dev/drfed/deployments",
    "--input",
    "-",
  ]);
  assert.deepEqual(createDeployment!.input, {
    ref: sha,
    task: "deploy",
    auto_merge: false,
    required_contexts: [],
    environment: "docs-release",
    payload: { version: "0.1.0", channel: "latest", runNumber: "123", sha },
    description: "Documentation 0.1.0",
    transient_environment: false,
    production_environment: true,
  });
  assert.equal(
    createIntent!.args[3],
    `repos/fedify-dev/drfed/deployments/${deployments[0]!.id}/statuses`,
  );
  assert.deepEqual(createIntent!.input, {
    state: "in_progress",
    log_url: "https://github.com/fedify-dev/drfed/actions/runs/456",
    auto_inactive: false,
  });
  assert.equal(createStatus!.args[3], createIntent!.args[3]);
  assert.deepEqual(createStatus!.input, {
    state: "success",
    log_url: "https://github.com/fedify-dev/drfed/actions/runs/456",
    auto_inactive: false,
    environment_url: "https://drfed.example/",
  });
  assert.deepEqual(
    deployments[0]!.statuses.map((item) => item.state),
    ["in_progress", "success"],
  );
  // A rerun of the same version sees its own record and redeploys.
  assert.equal(await docsCurrent(), true);
  // Another environment's records never order this one.
  assert.equal(await docsCurrent(devEnv), true);
  await recordDocs(devEnv);
  assert.equal(deployments.length, 2);
  assert.equal(deployments[1]!.environment, "docs-canary");
  assert.deepEqual(deployments[1]!.payload, devRecord("123"));
  assert.equal(await docsCurrent(devEnv), true);
  // A newer release record skips an older tag without failing the job.
  seedDeployment("docs-release", releaseRecord("0.2.0"), ["success"]);
  assert.equal(await docsCurrent(), false);
  // SemVer orders across channels: a higher prerelease is also newer.
  deployments.at(-1)!.statuses.push({ id: (githubId += 1), state: "inactive" });
  seedDeployment("docs-release", releaseRecord("0.2.0-rc.1"), ["success"]);
  assert.equal(await docsCurrent(), false);
  assert.equal(
    docsWarning,
    `::warning title=Docs deployment skipped::Skipped docs 0.1.0 (run 123) because docs-release already serves 0.2.0-rc.1 (run 100, ${sha}).`,
  );
  // GitHub may return the payload as a JSON string; it is parsed the same way.
  deployments.at(-1)!.statuses.push({ id: (githubId += 1), state: "inactive" });
  seedDeployment(
    "docs-release",
    JSON.stringify(releaseRecord("0.2.0")),
    ["success"],
    sha,
  );
  assert.equal(await docsCurrent(), false);
  // A string payload that is not JSON fails closed like any malformed record.
  deployments.at(-1)!.statuses.push({ id: (githubId += 1), state: "inactive" });
  const unparsable = seedDeployment(
    "docs-release",
    "version=0.2.0",
    ["success"],
    sha,
  );
  await assert.rejects(docsCurrent(), /Malformed docs deployment/u);
  unparsable.statuses.push({ id: (githubId += 1), state: "inactive" });
  // An unresolved malformed intent fails closed before the site is read.
  unparsable.statuses.push({ id: (githubId += 1), state: "failure" });
  await assert.rejects(docsCurrent(), /Malformed docs deployment/u);
  unparsable.statuses.push({ id: (githubId += 1), state: "inactive" });
  // Intents the site does not serve, whatever their newest status other than
  // success, are marked inactive in favor of older records.
  const unserved = ([[], ["error"], ["failure"], ["in_progress"]] as const).map(
    (states) =>
      seedDeployment("docs-release", releaseRecord("0.3.0"), [...states]),
  );
  servedDocs = releaseRecord("0.1.0");
  assert.equal(await docsCurrent(), true);
  for (const deployment of unserved) {
    assert.equal(deployment.statuses.at(-1)!.state, "inactive");
  }
  // A site that names no build serves none of them either.
  servedDocs = undefined;
  const unnamed = seedDeployment("docs-release", releaseRecord("0.3.0"), [
    "in_progress",
  ]);
  assert.equal(await docsCurrent(), true);
  assert.equal(unnamed.statuses.at(-1)!.state, "inactive");
  // A newer build that reached the site without its success record blocks an
  // older one, and is recorded as successful.
  const unrecorded = seedDeployment("docs-release", releaseRecord("0.2.0"), [
    "in_progress",
  ]);
  servedDocs = releaseRecord("0.2.0");
  assert.equal(await docsCurrent(), false);
  assert.deepEqual(
    unrecorded.statuses.map((item) => item.state),
    ["in_progress", "success"],
  );
  servedDocs = undefined;
  assert.equal(await docsCurrent(), false);
  unrecorded.statuses.push({ id: (githubId += 1), state: "inactive" });
  // The site is matched on the whole record, not on the commit alone.
  const otherRun = seedDeployment("docs-release", releaseRecord("0.2.0"), [
    "in_progress",
  ]);
  servedDocs = { ...releaseRecord("0.2.0"), runNumber: "101" };
  assert.equal(await docsCurrent(), true);
  assert.equal(otherRun.statuses.at(-1)!.state, "inactive");
  // A site that cannot be read, or names a malformed build, fails closed and
  // leaves the intent unresolved.
  const pending = seedDeployment("docs-release", releaseRecord("0.2.0"), [
    "in_progress",
  ]);
  for (const failure of [403, 500]) {
    servedDocsStatus = failure;
    await assert.rejects(docsCurrent(), new RegExp(`HTTP ${failure}`, "u"));
  }
  servedDocsStatus = 0;
  for (const malformed of [
    "not json",
    { ...releaseRecord("0.2.0"), channel: "dev" },
    { ...releaseRecord("0.2.0"), sha: "short" },
  ]) {
    servedDocs = malformed;
    await assert.rejects(docsCurrent(), /Malformed http:/u);
  }
  assert.deepEqual(
    pending.statuses.map((item) => item.state),
    ["in_progress"],
  );
  await assert.rejects(
    docsCurrent({ DRFED_DOCS_URL: "" }),
    /DRFED_DOCS_URL is required/u,
  );
  pending.statuses.push({ id: (githubId += 1), state: "inactive" });
  servedDocs = undefined;
  // A malformed record fails closed until a maintainer deactivates it.
  const malformed = seedDeployment(
    "docs-release",
    { ...releaseRecord("0.0.1"), version: "v0.0.1" },
    ["success"],
  );
  await assert.rejects(docsCurrent(), /Unsupported version/u);
  malformed.statuses.push({ id: (githubId += 1), state: "inactive" });
  seedDeployment(
    "docs-release",
    releaseRecord("0.0.9"),
    ["success"],
    "f".repeat(40),
  );
  await assert.rejects(docsCurrent(), /Malformed docs deployment/u);
  deployments.at(-1)!.statuses.push({ id: (githubId += 1), state: "inactive" });
  seedDeployment("docs-release", releaseRecord("0.1.0", "e".repeat(40)), [
    "success",
  ]);
  await assert.rejects(docsCurrent(), /Same docs build from another commit/u);
  deployments.at(-1)!.statuses.push({ id: (githubId += 1), state: "inactive" });
  seedDeployment("docs-release", releaseRecord("0.0.9"), ["success"]);
  assert.equal(await docsCurrent(), true);
  // API failures are never read as an empty deployment history.
  for (const failure of [401, 404, 500]) {
    githubStatus = failure;
    await assert.rejects(docsCurrent());
    githubStatus = 0;
  }
  // A deleted or moved remote tag fails before anything is deployed.
  await git("commit", "--allow-empty", "-qm", "Moved docs tag fixture");
  await git("tag", "-f", "0.1.0");
  await assert.rejects(docsCurrent(), /Remote tag was deleted or retargeted/u);
  await git("checkout", "--detach", sha);
  await git("tag", "-d", "0.1.0");
  await assert.rejects(docsCurrent(), /Remote tag was deleted or retargeted/u);
  await git("tag", "0.1.0", sha);
  assert.equal(await docsCurrent(), true);
  // Dev runs order by run number as an integer, not by version or string.
  seedDeployment("docs-canary", devRecord("99"), ["success"]);
  assert.equal(await docsCurrent(devEnv), true);
  seedDeployment("docs-canary", devRecord("124", "d".repeat(40)), ["success"]);
  assert.equal(await docsCurrent(devEnv), false);
  // Pagination: a newer record behind a full page of superseded deployments.
  deployments.at(-1)!.statuses.push({ id: (githubId += 1), state: "inactive" });
  assert.equal(await docsCurrent(devEnv), true);
  seedDeployment("docs-canary", devRecord("200", "c".repeat(40)), ["success"]);
  for (let index = 0; index < 100; index += 1) {
    seedDeployment("docs-canary", devRecord(String(300 + index)), [
      "success",
      "inactive",
    ]);
  }
  // Serve the newest records first on this listing only.
  deployments.reverse();
  deploymentPages.length = 0;
  assert.equal(await docsCurrent(devEnv), false);
  assert.ok(deploymentPages.some((query) => query.includes("page=2")));
  deployments.reverse();
  deployments
    .at(-101)!
    .statuses.push({ id: (githubId += 1), state: "inactive" });
  deploymentPages.length = 0;
  assert.equal(await docsCurrent(devEnv), true);
  assert.ok(deploymentPages.some((query) => query.includes("page=2")));
  // A recorded run is what the next check sees.
  deploymentRequests.length = 0;
  const recorded = deployments.length;
  await recordDocs({
    ...devEnv,
    GITHUB_RUN_NUMBER: "500",
    GITHUB_RUN_ID: "900",
    DRFED_RELEASE_BUILD: JSON.stringify({
      ...build,
      version: "0.1.0-dev.500",
      fullVersion: `0.1.0-dev.500+${sha.slice(0, 8)}`,
      runNumber: "500",
      runId: "900",
    }),
  });
  assert.equal(deployments.length, recorded + 1);
  assert.equal(deploymentRequests.length, 3);
  assert.equal(await docsCurrent(devEnv), false);
  const devRecordEnv = (runNumber: string) => ({
    ...devEnv,
    GITHUB_RUN_NUMBER: runNumber,
    GITHUB_RUN_ID: "900",
    DRFED_RELEASE_BUILD: JSON.stringify({
      ...build,
      version: `0.1.0-dev.${runNumber}`,
      fullVersion: `0.1.0-dev.${runNumber}+${sha.slice(0, 8)}`,
      runNumber,
      runId: "900",
    }),
  });
  // A rejected deployment fails at once, without retrying or a status.
  for (const failure of [404, 422]) {
    deploymentRequests.length = 0;
    githubPostFailures.push({ path: /\/deployments$/u, status: failure });
    await assert.rejects(docsIntent(devRecordEnv("501")));
    assert.equal(githubPostFailures.length, 0);
    assert.equal(deploymentRequests.length, 1);
    assert.equal(deployments.length, recorded + 1);
  }
  // A transient status failure is retried on the same deployment.
  deploymentRequests.length = 0;
  githubPostFailures.push({ path: /\/statuses$/u, status: 503 });
  await recordDocs(devRecordEnv("502"));
  assert.equal(githubPostFailures.length, 0);
  assert.equal(deployments.length, recorded + 2);
  const retried = deployments.at(-1)!;
  assert.deepEqual(
    retried.statuses.map((item) => item.state),
    ["in_progress", "success"],
  );
  assert.deepEqual(
    deploymentRequests.map(
      (item) => `${(item.args as string[])[3]} ${item.failure ?? "ok"}`,
    ),
    [
      "repos/fedify-dev/drfed/deployments ok",
      `repos/fedify-dev/drfed/deployments/${retried.id}/statuses 503`,
      `repos/fedify-dev/drfed/deployments/${retried.id}/statuses ok`,
      `repos/fedify-dev/drfed/deployments/${retried.id}/statuses ok`,
    ],
  );
  assert.equal(await docsCurrent(devEnv), false);
  await git("tag", "-d", "0.1.0");
  await assert.rejects(run(["publish"]));
  for (const name of names) {
    const path = join(root, "packages", name, "package.json");
    const prereleaseManifest = JSON.parse(await readFile(path, "utf8"));
    prereleaseManifest.version = "0.1.0-rc.1";
    delete prereleaseManifest.drfedBuild;
    await writeFile(path, JSON.stringify(prereleaseManifest));
  }
  env.GITHUB_REF = "refs/tags/0.1.0-rc.1";
  env.GITHUB_RUN_NUMBER = "124";
  env.GITHUB_RUN_ID = "457";
  env.DRFED_RELEASE_BUILD = (await run(["version"])).stdout.trim();
  await git("tag", "0.1.0-rc.1", sha);
  await run(["apply"]);
  await writeFile(join(root, "changes.d/next"), "0.1.0-rc.1\n");
  await writeFile(
    join(root, "changes.d/next-tag.md"),
    " -  Prerelease fixture notes.\n",
  );
  await execute(sacho, ["fmt"], { cwd: root, env });
  await execute(sacho, ["release", "0.1.0-rc.1", "--date", "2026-10-12"], {
    cwd: root,
    env,
  });
  await run(["pack"]);
  operations.length = 0;
  for (const name of names) tags.get(`@drfed/${name}`)!.next = "0.1.0-rc.2";
  await run(["publish"]);
  for (const name of names) {
    assert.equal(tags.get(`@drfed/${name}`)!.next, "0.1.0-rc.2");
  }
  githubRelease = undefined;
  githubOperations.length = 0;
  await writeImageManifest();
  await run(["github-release", "--github-api", registry]);
  assert.ok(githubRelease!.prerelease);
  assert.equal(
    githubOperations[0]![githubOperations[0]!.indexOf("--title") + 1],
    "DrFed 0.1.0-rc.1",
  );
  assert.ok(githubOperations[0]!.includes("--latest=false"));
  // Real pinned npm PUT: semver.clean drops build metadata, integrity covers
  // the exact packed bytes rather than a freshly rewritten tarball.
  const normalization = join(temporary, "normalization");
  await mkdir(normalization);
  await writeFile(
    join(normalization, "package.json"),
    JSON.stringify({
      name: "@fixture/normalization",
      version: "0.1.0-dev.123+abcdef0",
      drfedBuild: { sha: "a".repeat(40), fullVersion: "0.1.0-dev.123+abcdef0" },
      repository: "https://github.com/fedify-dev/drfed",
    }),
  );
  const npm = (await execute("mise", ["which", "npm"])).stdout.trim();
  assert.equal((await execute(npm, ["--version"])).stdout.trim(), "12.2.0");
  const npmrc = join(temporary, "npmrc");
  await writeFile(npmrc, `//127.0.0.1:${address.port}/:_authToken=fixture\n`);
  const npmEnv = {
    ...env,
    npm_config_userconfig: npmrc,
    npm_config_globalconfig: join(temporary, "global-npmrc"),
    npm_config_cache: join(temporary, "npm-cache"),
  };
  await writeFile(npmEnv.npm_config_globalconfig, "");
  const packed = JSON.parse(
    (
      await execute(npm, ["pack", "--json", "--ignore-scripts"], {
        cwd: normalization,
        env: npmEnv,
      })
    ).stdout,
  )["@fixture/normalization"];
  await execute(
    npm,
    [
      "publish",
      join(normalization, packed.filename),
      "--registry",
      registry,
      "--tag",
      "dev",
      "--access",
      "public",
      "--ignore-scripts",
      "--provenance=false",
    ],
    { cwd: normalization, env: npmEnv, timeout: 30_000 },
  );
  assert.ok(putDocument);
  const published = putDocument.versions["0.1.0-dev.123"];
  assert.ok(published);
  assert.equal(published.version, "0.1.0-dev.123");
  assert.deepEqual(published.drfedBuild, {
    sha: "a".repeat(40),
    fullVersion: "0.1.0-dev.123+abcdef0",
  });
  assert.equal(
    published.dist.integrity,
    integrity(await readFile(join(normalization, packed.filename))),
  );
  assert.equal(
    JSON.parse(
      (
        await execute("tar", [
          "-xOf",
          join(normalization, packed.filename),
          "package/package.json",
        ])
      ).stdout,
    ).version,
    "0.1.0-dev.123+abcdef0",
  );
  console.log(
    "Release fixtures passed: versions, authorization, normalization, exact artifacts, partial recovery, retries, conflicts, late channel promotion and docs deployment ordering.",
  );
} finally {
  await promisify(server.close.bind(server))();
  await rm(temporary, { recursive: true, force: true });
}
