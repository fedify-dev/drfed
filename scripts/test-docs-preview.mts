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
// oxlint-disable no-await-in-loop node/no-top-level-await

// Exercises scripts/docs-preview.mts against a loopback stand-in for the
// GitHub API, so that it needs neither network access nor a token, and
// scripts/docs-deploy.mts against a stand-in for wrangler, so that it needs
// neither wrangler nor Cloudflare credentials.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  codeEntries,
  deployBranch,
  deployCommit,
  parseDeployOutput,
  projectName,
  verifyDist,
  wranglerArguments,
} from "./docs-deploy.mts";
import {
  type IssueComment,
  type PreviewHead,
  type PullRequest,
  type WorkflowJob,
  commentAuthor,
  commentBody,
  docsJobSucceeded,
  marker,
  previewComments,
  previewUrl,
  selectPullRequest,
} from "./docs-preview.mts";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("./docs-preview.mts", import.meta.url));
const token = "test-token";
const repository = "fedify-dev/drfed";
const headSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const bot = { login: commentAuthor, type: "Bot" } as const;
const user = { login: "mallory", type: "User" } as const;

// The CI environment of the check job must never leak into the children:
// GITHUB_OUTPUT would receive their outputs, and a token would be sent.
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(?:ACTIONS_|GH_|GITHUB_|RUNNER_|NODE_USE_ENV_PROXY$|(?:HTTPS?|ALL)_PROXY$)/iu.test(
        key,
      ),
  ),
);

const pull = (
  overrides: {
    readonly number?: number;
    readonly state?: string;
    readonly sha?: string;
    readonly ref?: string;
    readonly headRepository?: string | null;
    readonly baseRepository?: string;
  } = {},
): PullRequest => ({
  number: overrides.number ?? 7,
  state: overrides.state ?? "open",
  head: {
    sha: overrides.sha ?? headSha,
    ref: overrides.ref ?? "feature",
    repo:
      overrides.headRepository === null
        ? null
        : { full_name: overrides.headRepository ?? "contributor/drfed" },
  },
  base: { repo: { full_name: overrides.baseRepository ?? repository } },
});

const forkHead: PreviewHead = {
  sha: headSha,
  repository: "contributor/drfed",
  branch: "feature",
};

const job = (
  name: string,
  conclusion: string | null,
  status = "completed",
): WorkflowJob => ({ name, status, conclusion, run_attempt: 2 });

const comment = (
  id: number,
  body: string | null,
  author: IssueComment["user"] = bot,
): IssueComment => ({ id, body, user: author });

describe("selectPullRequest()", () => {
  it("accepts an open pull request from a fork", () => {
    assert.equal(selectPullRequest([pull()], repository, forkHead), 7);
  });

  it("accepts an open pull request from the same repository", () => {
    const head = { ...forkHead, repository };
    const same = pull({ number: 8, headRepository: repository });
    assert.equal(selectPullRequest([same], repository, head), 8);
  });

  it("rejects a head SHA that moved on", () => {
    const moved = pull({ sha: otherSha });
    assert.equal(selectPullRequest([moved], repository, forkHead), null);
  });

  it("rejects a head from another repository", () => {
    const other = pull({ headRepository: "someone/drfed" });
    assert.equal(selectPullRequest([other], repository, forkHead), null);
  });

  it("rejects a deleted head repository", () => {
    const deleted = pull({ headRepository: null });
    assert.equal(selectPullRequest([deleted], repository, forkHead), null);
  });

  it("rejects another head branch", () => {
    const other = pull({ ref: "other" });
    assert.equal(selectPullRequest([other], repository, forkHead), null);
  });

  it("rejects a pull request into another repository", () => {
    const other = pull({ baseRepository: "someone/drfed" });
    assert.equal(selectPullRequest([other], repository, forkHead), null);
  });

  it("rejects a closed pull request", () => {
    const closed = pull({ state: "closed" });
    assert.equal(selectPullRequest([closed], repository, forkHead), null);
  });

  it("rejects an ambiguous match and an empty list", () => {
    const pulls = [pull(), pull({ number: 9 })];
    assert.equal(selectPullRequest(pulls, repository, forkHead), null);
    assert.equal(selectPullRequest([], repository, forkHead), null);
  });
});

describe("docsJobSucceeded()", () => {
  it("accepts a single successful docs job", () => {
    const jobs = [job("check", "failure"), job("docs", "success")];
    assert.equal(docsJobSucceeded(jobs), true);
  });

  it("rejects a failed, skipped, or unfinished docs job", () => {
    assert.equal(docsJobSucceeded([job("docs", "failure")]), false);
    assert.equal(docsJobSucceeded([job("docs", "skipped")]), false);
    assert.equal(docsJobSucceeded([job("docs", null, "in_progress")]), false);
  });

  it("rejects a missing or duplicated docs job", () => {
    assert.equal(docsJobSucceeded([]), false);
    assert.equal(docsJobSucceeded([job("check", "success")]), false);
    const twice = [job("docs", "success"), job("docs", "success")];
    assert.equal(docsJobSucceeded(twice), false);
  });
});

describe("previewComments()", () => {
  it("keeps only bot comments whose first line is the marker", () => {
    const comments = [
      comment(9, `${marker}\nnewer`),
      comment(5, `${marker}\r\nolder`),
      comment(2, `${marker}\nquoted`, user),
      comment(3, `quoting ${marker}`),
      comment(4, null),
      comment(6, marker, null),
      comment(8, marker, { login: commentAuthor, type: "User" }),
    ];
    assert.deepEqual(
      previewComments(comments).map(({ id }) => id),
      [5, 9],
    );
  });
});

describe("previewUrl()", () => {
  it("accepts only https: URLs", () => {
    assert.equal(
      previewUrl(" https://pr-1.drfed.pages.dev "),
      "https://pr-1.drfed.pages.dev/",
    );
    assert.equal(previewUrl("http://pr-1.drfed.pages.dev"), null);
    assert.equal(previewUrl("data:text/html,x"), null);
    assert.equal(previewUrl("not a url"), null);
    assert.equal(previewUrl(""), null);
    assert.equal(previewUrl(undefined), null);
  });
});

describe("commentBody()", () => {
  it("starts with the marker and lists both URLs", () => {
    const body = commentBody(headSha, "https://a/", "https://d/");
    assert.ok(body.startsWith(`${marker}\n`));
    assert.ok(body.includes(headSha));
    assert.ok(body.includes("<https://a/>"));
    assert.ok(body.includes("<https://d/>"));
  });

  it("omits the alias line without an alias URL", () => {
    const body = commentBody(headSha, null, "https://d/");
    assert.ok(!body.includes("Latest preview"));
    assert.ok(body.includes("<https://d/>"));
  });
});

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

/** Listing pages served for each GET path; single objects have one page. */
let pages = new Map<string, readonly unknown[]>();
let requests: Recorded[] = [];
let server: Server;
let api: string;
let temporary: string;

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "drfed-docs-preview-"));
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", api);
    let data = "";
    for await (const chunk of request) data += String(chunk);
    requests.push({
      method: request.method ?? "",
      path: url.pathname,
      query: url.searchParams,
      body: data === "" ? undefined : JSON.parse(data),
    });
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    const headers = { "content-type": "application/json" };
    if (request.method !== "GET") {
      response
        .writeHead(request.method === "POST" ? 201 : 200, headers)
        .end("{}");
      return;
    }
    const served = pages.get(url.pathname);
    const page = Number(url.searchParams.get("page") ?? "1");
    if (served == null || page > served.length) {
      response.writeHead(404, headers).end('{"message":"Not Found"}');
      return;
    }
    const link: Record<string, string> = {};
    if (page < served.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      link.link = `<${next.href}>; rel="next", <${api}last>; rel="last"`;
    }
    response
      .writeHead(200, { ...headers, ...link })
      .end(JSON.stringify(served[page - 1]));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

after(async () => {
  server.closeAllConnections();
  await promisify(server.close.bind(server))();
  await rm(temporary, { recursive: true, force: true });
});

/**
 * Runs one command of the script against the loopback API.
 * @returns The outputs it appended to `GITHUB_OUTPUT`.
 */
async function run(
  command: string,
  served: Record<string, readonly unknown[]>,
  env: Record<string, string>,
): Promise<string> {
  pages = new Map(Object.entries(served));
  requests = [];
  const output = join(temporary, "output");
  await writeFile(output, "");
  await execute(process.execPath, [script, command], {
    cwd: temporary,
    env: {
      ...baseEnv,
      GITHUB_API_URL: api,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: repository,
      GH_TOKEN: token,
      HEAD_SHA: headSha,
      ...env,
    },
  });
  return await readFile(output, "utf8");
}

const writes = (): readonly (readonly [string, string])[] =>
  requests
    .filter(({ method }) => method !== "GET")
    .map(({ method, path }) => [method, path] as const);

const commentsPath = `/repos/${repository}/issues/7/comments`;
const commentEnv = {
  PR_NUMBER: "7",
  ALIAS_URL: "https://pr-7.drfed.pages.dev",
  DEPLOYMENT_URL: "https://0123abcd.drfed.pages.dev",
};

describe("docs-preview comment", () => {
  it("updates the oldest bot comment found on a later page", async () => {
    const filler = Array.from({ length: 100 }, (_, index) =>
      comment(index + 1, "unrelated"),
    );
    await run(
      "comment",
      {
        [commentsPath]: [
          filler,
          [
            comment(300, `${marker}\nnewer`),
            comment(150, `${marker}\nquoted`, user),
            comment(200, `${marker}\nolder`),
          ],
        ],
      },
      commentEnv,
    );
    const reads = requests.filter(({ method }) => method === "GET");
    assert.deepEqual(
      reads.map(({ query }) => [
        query.get("per_page"),
        query.get("page") ?? "1",
      ]),
      [
        ["100", "1"],
        ["100", "2"],
      ],
    );
    assert.deepEqual(writes(), [
      ["PATCH", `/repos/${repository}/issues/comments/200`],
    ]);
    const { body } = requests.at(-1)!.body as { body: string };
    assert.equal(
      body,
      commentBody(
        headSha,
        "https://pr-7.drfed.pages.dev/",
        "https://0123abcd.drfed.pages.dev/",
      ),
    );
  });

  it("posts a new comment when only a user quoted the marker", async () => {
    await run(
      "comment",
      { [commentsPath]: [[comment(1, `${marker}\nquoted`, user)]] },
      commentEnv,
    );
    assert.deepEqual(writes(), [["POST", commentsPath]]);
  });

  it("leaves out a non-https alias URL", async () => {
    await run(
      "comment",
      { [commentsPath]: [[]] },
      { ...commentEnv, ALIAS_URL: "http://pr-7.drfed.pages.dev" },
    );
    const { body } = requests.at(-1)!.body as { body: string };
    assert.ok(!body.includes("pr-7.drfed.pages.dev"));
  });

  it("refuses a non-https deployment URL without writing", async () => {
    for (const url of [
      "http://0123abcd.drfed.pages.dev",
      "",
      "file:///etc/passwd",
    ]) {
      await assert.rejects(
        run(
          "comment",
          { [commentsPath]: [[]] },
          { ...commentEnv, DEPLOYMENT_URL: url },
        ),
        /DEPLOYMENT_URL/u,
      );
      assert.deepEqual(requests, []);
    }
  });
});

const pullsPath = `/repos/${repository}/pulls`;
const prEnv = { HEAD_REPOSITORY: "contributor/drfed", HEAD_BRANCH: "feature" };

describe("docs-preview pr", () => {
  it("finds a fork pull request by its head label", async () => {
    const output = await run("pr", { [pullsPath]: [[pull()]] }, prEnv);
    assert.equal(output, "number=7\n");
    const [read] = requests;
    assert.equal(read?.query.get("state"), "open");
    assert.equal(read?.query.get("head"), "contributor:feature");
  });

  it("finds a same-repository pull request", async () => {
    const same = pull({ number: 8, headRepository: repository });
    const output = await run(
      "pr",
      { [pullsPath]: [[same]] },
      { ...prEnv, HEAD_REPOSITORY: repository },
    );
    assert.equal(output, "number=8\n");
    assert.equal(requests[0]?.query.get("head"), "fedify-dev:feature");
  });

  it("follows pagination", async () => {
    const output = await run(
      "pr",
      { [pullsPath]: [[pull({ number: 3, sha: otherSha })], [pull()]] },
      prEnv,
    );
    assert.equal(output, "number=7\n");
  });

  it("reports nothing without a single exact match", async () => {
    const cases: readonly (readonly PullRequest[])[] = [
      [],
      [pull({ sha: otherSha })],
      [pull({ headRepository: "someone/drfed" })],
      [pull({ ref: "other" })],
      [pull(), pull({ number: 9 })],
    ];
    for (const pulls of cases) {
      assert.equal(await run("pr", { [pullsPath]: [pulls] }, prEnv), "");
      assert.deepEqual(writes(), []);
    }
  });

  it("refuses a malformed head SHA before any request", async () => {
    await assert.rejects(
      run("pr", { [pullsPath]: [[pull()]] }, { ...prEnv, HEAD_SHA: "main" }),
      /HEAD_SHA/u,
    );
    assert.deepEqual(requests, []);
  });
});

const runId = 4242;
const runPath = `/repos/${repository}/actions/runs/${runId}`;
const workflowRun = {
  id: runId,
  path: ".github/workflows/docs.yaml",
  event: "pull_request",
  head_sha: headSha,
};
const builtEnv = { RUN_ID: String(runId) };

describe("docs-preview built", () => {
  const served = (
    jobs: readonly (readonly WorkflowJob[])[],
    workflow: Record<string, unknown> = workflowRun,
  ) => ({
    [runPath]: [workflow],
    [`${runPath}/jobs`]: jobs.map((page) => ({
      total_count: jobs.flat().length,
      jobs: page,
    })),
  });

  it("reports a successful docs job", async () => {
    const output = await run(
      "built",
      served([[job("check", "success")], [job("docs", "success")]]),
      builtEnv,
    );
    assert.equal(output, "built=true\n");
    const jobsRead = requests.find(({ path }) => path === `${runPath}/jobs`);
    assert.equal(jobsRead?.query.get("filter"), "latest");
  });

  it("reports a failed docs job", async () => {
    const output = await run(
      "built",
      served([[job("docs", "failure")]]),
      builtEnv,
    );
    assert.equal(output, "built=false\n");
  });

  it("reports a missing docs job", async () => {
    const output = await run(
      "built",
      served([[job("check", "success")]]),
      builtEnv,
    );
    assert.equal(output, "built=false\n");
  });

  it("refuses a run of another commit, workflow, or event", async () => {
    const runs = [
      { ...workflowRun, head_sha: otherSha },
      { ...workflowRun, path: ".github/workflows/docs-preview.yaml" },
      { ...workflowRun, event: "push" },
    ];
    for (const other of runs) {
      await assert.rejects(
        run("built", served([[job("docs", "success")]], other), builtEnv),
      );
      assert.ok(!requests.some(({ path }) => path === `${runPath}/jobs`));
    }
  });
});

const deployScript = fileURLToPath(
  new URL("./docs-deploy.mts", import.meta.url),
);
const session = JSON.stringify({
  type: "wrangler-session",
  version: 1,
  wrangler_version: "4.149.0",
});
const pagesDeploy = JSON.stringify({
  type: "pages-deploy",
  version: 1,
  pages_project: "drfed",
  deployment_id: "0123abcd",
  url: "https://ignored.drfed.pages.dev",
});
const detailed = (fields: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "pages-deploy-detailed",
    version: 1,
    pages_project: "drfed",
    deployment_id: "0123abcd",
    url: "https://0123abcd.drfed.pages.dev",
    alias: "https://pr-7.drfed.pages.dev",
    environment: "preview",
    production_branch: "main",
    deployment_trigger: { metadata: { commit_hash: headSha } },
    timestamp: "2026-10-15T00:00:00.000Z",
    ...fields,
  });

describe("parseDeployOutput()", () => {
  it("reads the first pages-deploy-detailed entry", () => {
    const text = [
      session,
      "not json",
      pagesDeploy,
      detailed(),
      detailed({ url: "https://later.drfed.pages.dev" }),
      "",
    ].join("\n");
    assert.deepEqual(parseDeployOutput(text), {
      deploymentUrl: "https://0123abcd.drfed.pages.dev/",
      aliasUrl: "https://pr-7.drfed.pages.dev/",
    });
  });

  it("skips entries of another version", () => {
    const text = [
      detailed({ version: 2, url: "https://v2.drfed.pages.dev" }),
      detailed(),
    ].join("\r\n");
    assert.equal(
      parseDeployOutput(text).deploymentUrl,
      "https://0123abcd.drfed.pages.dev/",
    );
  });

  it("reports no alias when it is missing or not https:", () => {
    for (const alias of [undefined, null, "", "http://pr-7.drfed.pages.dev"]) {
      assert.equal(parseDeployOutput(detailed({ alias })).aliasUrl, null);
    }
  });

  it("refuses a missing or non-https deployment URL", () => {
    for (const url of [undefined, null, "", "http://x.drfed.pages.dev"]) {
      assert.throws(
        () => parseDeployOutput(detailed({ url })),
        /deployment URL/u,
      );
    }
  });

  it("refuses output without a pages-deploy-detailed entry", () => {
    for (const text of ["", session, `${session}\n${pagesDeploy}\n`]) {
      assert.throws(() => parseDeployOutput(text), /pages-deploy-detailed/u);
    }
  });
});

describe("deployment target validation", () => {
  it("accepts only main and pr-<number> branches", () => {
    assert.equal(deployBranch("main"), "main");
    assert.equal(deployBranch("pr-12"), "pr-12");
    for (const branch of [
      undefined,
      "",
      "pr-0",
      "pr-",
      "pr-1 --x",
      "feature",
      "main\n",
    ]) {
      assert.throws(() => deployBranch(branch), /DOCS_BRANCH/u);
    }
  });

  it("accepts only full commit SHAs", () => {
    assert.equal(deployCommit(headSha), headSha);
    for (const commit of [undefined, "", "abc", "A".repeat(40), "main"]) {
      assert.throws(() => deployCommit(commit), /DOCS_COMMIT/u);
    }
  });

  it("accepts only Cloudflare Pages project names", () => {
    assert.equal(projectName("drfed-docs"), "drfed-docs");
    for (const name of [
      undefined,
      "",
      "-x",
      "x-",
      "Drfed",
      "a b",
      "x".repeat(59),
    ]) {
      assert.throws(() => projectName(name), /CLOUDFLARE_PROJECT_NAME/u);
    }
  });

  it("never passes a commit message to wrangler", () => {
    assert.deepEqual(wranglerArguments("/d", "drfed", "pr-7", headSha), [
      "pages",
      "deploy",
      "/d",
      "--project-name=drfed",
      "--branch=pr-7",
      `--commit-hash=${headSha}`,
    ]);
  });
});

/**
 * Creates a documentation build and an empty directory to run wrangler in.
 * @returns The two directories.
 */
async function fixtureDist(): Promise<{ dist: string; cwd: string }> {
  const root = await mkdtemp(join(temporary, "dist-"));
  const dist = join(root, "dist");
  const cwd = join(root, "cwd");
  await mkdir(dist);
  await mkdir(cwd);
  await writeFile(join(dist, "index.html"), "<p>docs</p>\n");
  return { dist, cwd };
}

describe("verifyDist()", () => {
  it("accepts plain static files", async () => {
    const { dist, cwd } = await fixtureDist();
    await writeFile(join(dist, "_headers"), "/*\n  X-Test: 1\n");
    await verifyDist(dist, cwd);
  });

  it("refuses every entry Cloudflare would run as code", async () => {
    for (const name of codeEntries) {
      for (const kind of ["file", "directory", "dangling link"] as const) {
        const { dist, cwd } = await fixtureDist();
        const path = join(dist, name);
        if (kind === "file") await writeFile(path, "");
        else if (kind === "directory") await mkdir(path);
        else await symlink(join(dist, "missing"), path);
        await assert.rejects(verifyDist(dist, cwd), new RegExp(name, "u"));
      }
    }
  });

  it("refuses functions/ where wrangler runs", async () => {
    const { dist, cwd } = await fixtureDist();
    await mkdir(join(cwd, "functions"));
    await assert.rejects(verifyDist(dist, cwd), /where wrangler runs/u);
  });

  it("refuses a build without index.html or a missing directory", async () => {
    const { dist, cwd } = await fixtureDist();
    await rm(join(dist, "index.html"));
    await assert.rejects(verifyDist(dist, cwd), /index\.html/u);
    await assert.rejects(
      verifyDist(join(dist, "missing"), cwd),
      /not a directory/u,
    );
  });
});

// A stand-in for wrangler: it records how it was run, writes the given
// ND-JSON to the output file wrangler would write, and exits as told.
const fakeWrangler = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
writeFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  ghToken: process.env.GH_TOKEN ?? null,
  githubToken: process.env.GITHUB_TOKEN ?? null,
  metrics: process.env.WRANGLER_SEND_METRICS ?? null,
  outputFile: process.env.WRANGLER_OUTPUT_FILE_PATH ?? null,
}));
if (process.env.FAKE_WRANGLER_OUTPUT) {
  appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, process.env.FAKE_WRANGLER_OUTPUT);
}
process.exit(Number(process.env.FAKE_WRANGLER_EXIT ?? "0"));
`;

interface WranglerLog {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly ghToken: string | null;
  readonly githubToken: string | null;
  readonly metrics: string | null;
  readonly outputFile: string | null;
}

describe("docs-deploy deploy", { skip: process.platform === "win32" }, () => {
  let bin: string;
  let log: string;

  before(async () => {
    bin = await mkdtemp(join(temporary, "bin-"));
    log = join(bin, "log.json");
    await writeFile(join(bin, "wrangler"), fakeWrangler);
    await chmod(join(bin, "wrangler"), 0o755);
  });

  /**
   * Runs the deploy command with the stand-in wrangler first on `PATH`.
   * @returns The outputs it appended to `GITHUB_OUTPUT`.
   */
  async function deploy(
    dist: string,
    env: Record<string, string> = {},
  ): Promise<string> {
    await rm(log, { force: true });
    const output = join(temporary, "deploy-output");
    await writeFile(output, "");
    await execute(process.execPath, [deployScript, "deploy"], {
      cwd: temporary,
      env: {
        ...baseEnv,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        GITHUB_OUTPUT: output,
        GH_TOKEN: token,
        GITHUB_TOKEN: token,
        WRANGLER_OUTPUT_FILE_DIRECTORY: temporary,
        FAKE_WRANGLER_LOG: log,
        FAKE_WRANGLER_OUTPUT: `${session}\n${pagesDeploy}\n${detailed()}\n`,
        CLOUDFLARE_API_TOKEN: "cloudflare-token",
        CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        CLOUDFLARE_PROJECT_NAME: "drfed",
        DOCS_BRANCH: "pr-7",
        DOCS_COMMIT: headSha,
        usage_dir: dist,
        ...env,
      },
    });
    return await readFile(output, "utf8");
  }

  const ranWrangler = async (): Promise<boolean> =>
    await readFile(log, "utf8").then(
      () => true,
      () => false,
    );

  it("deploys from the repository root and reports both URLs", async () => {
    const { dist } = await fixtureDist();
    const output = await deploy(dist);
    assert.equal(
      output,
      "deployment-url=https://0123abcd.drfed.pages.dev/\n" +
        "alias-url=https://pr-7.drfed.pages.dev/\n",
    );
    const ran = JSON.parse(await readFile(log, "utf8")) as WranglerLog;
    assert.deepEqual(
      ran.argv,
      wranglerArguments(dist, "drfed", "pr-7", headSha),
    );
    assert.equal(
      ran.cwd,
      fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, ""),
    );
    assert.equal(ran.ghToken, null);
    assert.equal(ran.githubToken, null);
    assert.equal(ran.metrics, "false");
    assert.ok(!ran.outputFile?.startsWith(temporary));
  });

  it("reports an empty alias when Cloudflare reported none", async () => {
    const { dist } = await fixtureDist();
    const output = await deploy(dist, {
      DOCS_BRANCH: "main",
      FAKE_WRANGLER_OUTPUT: `${detailed({ alias: undefined })}\n`,
    });
    assert.equal(
      output,
      "deployment-url=https://0123abcd.drfed.pages.dev/\nalias-url=\n",
    );
  });

  it("refuses an unsafe build before running wrangler", async () => {
    const { dist } = await fixtureDist();
    await writeFile(join(dist, "_worker.js"), "export default {};\n");
    await assert.rejects(deploy(dist), /_worker\.js/u);
    assert.equal(await ranWrangler(), false);
  });

  it("refuses a missing credential or bad target before running wrangler", async () => {
    const { dist } = await fixtureDist();
    const cases: readonly (readonly [Record<string, string>, RegExp])[] = [
      [{ CLOUDFLARE_API_TOKEN: "" }, /CLOUDFLARE_API_TOKEN/u],
      [{ CLOUDFLARE_ACCOUNT_ID: "" }, /CLOUDFLARE_ACCOUNT_ID/u],
      [{ CLOUDFLARE_PROJECT_NAME: "" }, /CLOUDFLARE_PROJECT_NAME/u],
      [{ DOCS_BRANCH: "pr-7 --x" }, /DOCS_BRANCH/u],
      [{ DOCS_COMMIT: "main" }, /DOCS_COMMIT/u],
    ];
    for (const [env, message] of cases) {
      await assert.rejects(deploy(dist, env), message);
      assert.equal(await ranWrangler(), false);
    }
  });

  it("fails without outputs when wrangler fails or reports nothing", async () => {
    const { dist } = await fixtureDist();
    const output = join(temporary, "deploy-output");
    await assert.rejects(
      deploy(dist, { FAKE_WRANGLER_EXIT: "1" }),
      /exit code 1/u,
    );
    assert.equal(await readFile(output, "utf8"), "");
    await assert.rejects(
      deploy(dist, { FAKE_WRANGLER_OUTPUT: `${session}\n` }),
      /pages-deploy-detailed/u,
    );
    assert.equal(await readFile(output, "utf8"), "");
  });
});
