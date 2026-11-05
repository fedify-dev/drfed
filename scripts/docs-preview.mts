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
// oxlint-disable no-console no-await-in-loop node/no-top-level-await

// Steps of the docs-preview workflow, which runs from the default branch with
// a write token on behalf of pull request runs that may come from forks.
// Every input that a pull request can influence (branch names, artifacts) is
// read from the environment and checked against the GitHub API rather than
// trusted, and nothing here executes any part of the pull request.

import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

/** The first line that identifies the single preview comment on a PR. */
export const marker = "<!-- drfed-docs-preview -->";

/** The workflow whose `docs` job uploads the documentation artifact. */
export const buildWorkflowPath = ".github/workflows/docs.yaml";

/** The account that posts comments with the workflow's `GITHUB_TOKEN`. */
export const commentAuthor = "github-actions[bot]";

const sha = /^[0-9a-f]{40}$/u;
const repositoryName = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u;

export interface PullRequest {
  readonly number: number;
  readonly state: string;
  readonly head: {
    readonly sha: string;
    readonly ref: string;
    readonly repo: { readonly full_name: string } | null;
  };
  readonly base: { readonly repo: { readonly full_name: string } };
}

export interface WorkflowRun {
  readonly id: number;
  readonly path: string;
  readonly event: string;
  readonly head_sha: string;
}

export interface WorkflowJob {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly run_attempt: number;
}

export interface IssueComment {
  readonly id: number;
  readonly body?: string | null;
  readonly user: { readonly login: string; readonly type: string } | null;
}

export interface PreviewHead {
  readonly sha: string;
  readonly repository: string;
  readonly branch: string;
}

/**
 * Picks the pull request a preview belongs to: an open PR into `repository`
 * whose head is still exactly the built commit on the built branch.  Anything
 * other than a single match yields `null`, so that a stale run never
 * overwrites the preview of a newer commit and an ambiguous match never
 * comments on the wrong pull request.
 * @returns The pull request number, or `null` without a single match.
 */
export function selectPullRequest(
  pulls: readonly PullRequest[],
  repository: string,
  head: PreviewHead,
): number | null {
  const matches = pulls.filter(
    (pull) =>
      pull.state === "open" &&
      pull.base.repo.full_name === repository &&
      pull.head.sha === head.sha &&
      pull.head.ref === head.branch &&
      pull.head.repo?.full_name === head.repository,
  );
  if (matches.length !== 1) return null;
  const [match] = matches;
  return match!.number;
}

/**
 * Tells whether the `docs` job of the run's latest attempt succeeded.  An
 * uploaded artifact alone does not prove that: a full rerun whose `docs` job
 * fails before uploading leaves the previous attempt's artifact in place.
 * Jobs that a partial rerun did not repeat are listed under the new attempt
 * with their earlier conclusion, so the latest attempt is enough.
 * @returns Whether exactly one `docs` job completed successfully.
 */
export function docsJobSucceeded(jobs: readonly WorkflowJob[]): boolean {
  const docs = jobs.filter((job) => job.name === "docs");
  if (docs.length !== 1) return false;
  const [job] = docs;
  return job!.status === "completed" && job!.conclusion === "success";
}

/**
 * Finds the preview comments this workflow posted earlier, oldest first.
 * The author is checked as well as the marker, so a comment in which someone
 * quoted the marker is never edited.
 * @returns The matching comments in increasing identifier order.
 */
export function previewComments(
  comments: readonly IssueComment[],
): readonly IssueComment[] {
  return comments
    .filter(
      (comment) =>
        comment.user?.login === commentAuthor &&
        comment.user.type === "Bot" &&
        (comment.body ?? "").split(/\r?\n/u, 1)[0] === marker,
    )
    .toSorted((left, right) => left.id - right.id);
}

/**
 * Accepts only an `https:` URL, which is all Cloudflare Pages reports.
 * @returns The normalized URL, or `null` for anything else.
 */
export function previewUrl(value: string | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const url = URL.parse(value.trim());
  return url?.protocol === "https:" ? url.href : null;
}

/**
 * Renders the body of the preview comment.
 * @returns The Markdown body, starting with the marker line.
 */
export function commentBody(
  headSha: string,
  aliasUrl: string | null,
  deploymentUrl: string,
): string {
  const lines = [
    marker,
    `The documentation preview for ${headSha} is ready.`,
    "",
  ];
  if (aliasUrl != null) {
    lines.push(` -  Latest preview of this pull request: <${aliasUrl}>`);
  }
  lines.push(` -  Preview of this commit: <${deploymentUrl}>`);
  return `${lines.join("\n")}\n`;
}

function environment(name: string): string {
  const value = process.env[name];
  assert.ok(value != null && value !== "", `${name} is required`);
  return value;
}

function targetRepository(): string {
  const value = environment("GITHUB_REPOSITORY");
  assert.match(value, repositoryName, "Malformed GITHUB_REPOSITORY");
  return value;
}

function builtSha(): string {
  const value = environment("HEAD_SHA");
  assert.match(value, sha, "HEAD_SHA must be a full commit SHA");
  return value;
}

function positiveInteger(name: string): number {
  const value = environment(name);
  assert.match(value, /^[1-9]\d*$/u, `${name} must be a positive integer`);
  return Number(value);
}

async function output(name: string, value: string): Promise<void> {
  console.log(`${name}=${value}`);
  const file = process.env.GITHUB_OUTPUT;
  if (file) await appendFile(file, `${name}=${value}\n`);
}

function apiUrl(path: string): URL {
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  return new URL(path, base.endsWith("/") ? base : `${base}/`);
}

async function request(
  method: string,
  url: URL,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "drfed-docs-preview",
  };
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // Only reads are retried; repeating a write could post a second comment.
  const attempts = method === "GET" ? 3 : 1;
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(30_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (attempt >= attempts) throw error;
      await delay(1000 * attempt);
      continue;
    }
    if (response.ok) return response;
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < attempts) {
      await delay(1000 * attempt);
      continue;
    }
    throw new Error(
      `${method} ${url.pathname}${url.search}: HTTP ${response.status} ${await response.text()}`,
    );
  }
}

async function getJson<T>(
  path: string,
  query: Record<string, string> = {},
): Promise<T> {
  const url = apiUrl(path);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return (await (await request("GET", url)).json()) as T;
}

function nextPage(link: string | null): URL | null {
  for (const part of (link ?? "").split(",")) {
    const match = /^\s*<(?<url>[^>]+)>\s*;\s*rel="next"\s*$/u.exec(part);
    if (match) return new URL(match.groups!.url!);
  }
  return null;
}

/**
 * Reads every page of a listing, following the `Link` header.
 * @returns The items of every page in order.
 */
async function getAll<T>(
  path: string,
  query: Record<string, string>,
  items: (page: unknown) => readonly T[],
): Promise<T[]> {
  let url: URL | null = apiUrl(path);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("per_page", "100");
  const result: T[] = [];
  while (url != null) {
    const response = await request("GET", url);
    const page = items(await response.json());
    assert.ok(Array.isArray(page), `GET ${url.pathname}: expected a list`);
    result.push(...page);
    url = nextPage(response.headers.get("link"));
  }
  return result;
}

const asList = <T,>(page: unknown): readonly T[] => page as readonly T[];

async function findPullRequest(): Promise<void> {
  const repo = targetRepository();
  const head: PreviewHead = {
    sha: builtSha(),
    repository: environment("HEAD_REPOSITORY"),
    branch: environment("HEAD_BRANCH"),
  };
  assert.match(head.repository, repositoryName, "Malformed HEAD_REPOSITORY");
  const [owner] = head.repository.split("/");
  // `commits/{sha}/pulls` does not list open pull requests from forks, and
  // `workflow_run.pull_requests` is empty for them, so look the pull request
  // up by its head label and check the result against the built commit.
  const pulls = await getAll<PullRequest>(
    `repos/${repo}/pulls`,
    { state: "open", head: `${owner}:${head.branch}` },
    asList,
  );
  const number = selectPullRequest(pulls, repo, head);
  if (number == null) {
    console.log(
      `No single open pull request has ${head.repository}@${head.sha} as its head (${pulls.length} candidates); skipping the preview.`,
    );
    return;
  }
  await output("number", String(number));
}

async function checkBuilt(): Promise<void> {
  const repo = targetRepository();
  const runId = positiveInteger("RUN_ID");
  const expectedSha = builtSha();
  const run = await getJson<WorkflowRun>(`repos/${repo}/actions/runs/${runId}`);
  assert.equal(run.id, runId);
  assert.equal(run.path, buildWorkflowPath, "Unexpected triggering workflow");
  assert.equal(run.event, "pull_request", "Unexpected triggering event");
  assert.equal(run.head_sha, expectedSha, "Run is for another commit");
  const jobs = await getAll<WorkflowJob>(
    `repos/${repo}/actions/runs/${runId}/jobs`,
    { filter: "latest" },
    (page) => (page as { jobs: readonly WorkflowJob[] }).jobs,
  );
  const built = docsJobSucceeded(jobs);
  if (!built) {
    console.log(
      `The docs job of the latest attempt of run ${runId} did not succeed; skipping the preview.`,
    );
  }
  await output("built", String(built));
}

async function postComment(): Promise<void> {
  const repo = targetRepository();
  const number = positiveInteger("PR_NUMBER");
  const deploymentUrl = previewUrl(process.env.DEPLOYMENT_URL);
  assert.ok(deploymentUrl != null, "DEPLOYMENT_URL must be an https: URL");
  const body = commentBody(
    builtSha(),
    previewUrl(process.env.ALIAS_URL),
    deploymentUrl,
  );
  const existing = previewComments(
    await getAll<IssueComment>(
      `repos/${repo}/issues/${number}/comments`,
      {},
      asList,
    ),
  );
  const [oldest] = existing;
  if (oldest == null) {
    await request("POST", apiUrl(`repos/${repo}/issues/${number}/comments`), {
      body,
    });
    console.log(`Posted the preview comment on #${number}`);
    return;
  }
  if (existing.length > 1) {
    console.log(
      `Found ${existing.length} preview comments on #${number}; updating the oldest (${oldest.id}) and leaving the rest.`,
    );
  }
  await request("PATCH", apiUrl(`repos/${repo}/issues/comments/${oldest.id}`), {
    body,
  });
  console.log(`Updated preview comment ${oldest.id} on #${number}`);
}

const commands: Readonly<Record<string, () => Promise<void>>> = {
  pr: findPullRequest,
  built: checkBuilt,
  comment: postComment,
};

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  const handler = command == null ? undefined : commands[command];
  if (handler == null) {
    throw new Error(`Expected one of: ${Object.keys(commands).join(", ")}`);
  }
  await handler();
}
