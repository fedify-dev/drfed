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

// Running container engines: processes, detection, loading layouts and
// cleaning up.  What differs between engines is data in engines.mts.
// oxlint-disable no-await-in-loop
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import {
  type EngineSpec,
  engines,
  imageIdCandidates,
  normalizeImageId,
  normalizePlatform,
} from "./engines.mts";
import { singleImage } from "./layout.mts";

export interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly timeout?: number | undefined;
  /** Pass the child's output through instead of collecting it. */
  readonly inherit?: boolean;
}

/**
 * Run a command to completion without throwing on its exit status.
 * @returns Its exit code and output.
 */
export async function exec(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<Result> {
  const child = spawn(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const timer = setTimeout(
    () => child.kill("SIGKILL"),
    options.timeout ?? 600_000,
  );
  try {
    // The once() call rejects when the child emits "error" first.
    const [code] = (await once(child, "close")) as [number | null];
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export async function succeed(
  command: string,
  args: readonly string[],
  options?: ExecOptions,
): Promise<Result> {
  const result = await exec(command, args, options);
  assert.equal(
    result.code,
    0,
    `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

/** A reachable engine, with every call going through its binary. */
export interface Engine {
  readonly spec: EngineSpec;
  readonly version: string;
  readonly platform: string;
  /** The first line of its Compose provider's version, when asked for. */
  readonly composeVersion?: string;
  readonly env: (extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  readonly run: (
    args: readonly string[],
    options?: ExecOptions,
  ) => Promise<Result>;
  readonly succeed: (
    args: readonly string[],
    options?: ExecOptions,
  ) => Promise<Result>;
  /** Run Compose with the given project environment. */
  readonly compose: (
    env: NodeJS.ProcessEnv,
    args: readonly string[],
    options?: Omit<ExecOptions, "env">,
  ) => Promise<Result>;
}

/** Thrown when an engine's binary is not on PATH. */
export class MissingEngine extends Error {
  readonly spec: EngineSpec;
  constructor(spec: EngineSpec) {
    super(`${spec.label} is not installed (no "${spec.binary}" on PATH)`);
    this.name = "MissingEngine";
    this.spec = spec;
  }
}

/**
 * Check that an engine is installed and reachable.
 * @returns The engine; throws MissingEngine without its binary, and an
 *          ordinary error when it cannot reach its server.
 */
export async function detect(
  spec: EngineSpec,
  options: { readonly compose?: boolean } = {},
): Promise<Engine> {
  const env = (extra: NodeJS.ProcessEnv = {}) => ({
    ...spec.env(process.env),
    ...extra,
  });
  const run = (args: readonly string[], opts: ExecOptions = {}) =>
    exec(spec.binary, args, { ...opts, env: opts.env ?? env() });
  try {
    await run(["--version"]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingEngine(spec);
    }
    throw error;
  }
  const info = await run(spec.info);
  if (info.code !== 0) {
    throw new Error(
      `${spec.label} is installed but cannot reach its engine:\n${info.stderr}`,
    );
  }
  const reported = await run(spec.platform);
  assert.equal(reported.code, 0, reported.stderr);
  const succeedWith = async (args: readonly string[], opts?: ExecOptions) => {
    const result = await run(args, opts);
    assert.equal(
      result.code,
      0,
      `${spec.binary} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
    );
    return result;
  };
  const composeVersion = options.compose
    ? (await succeedWith([...spec.compose, "version"])).stdout
        .trim()
        .split("\n")[0]
    : undefined;
  return {
    spec,
    version: info.stdout.trim(),
    platform: normalizePlatform(reported.stdout),
    ...(composeVersion === undefined ? {} : { composeVersion }),
    env,
    run,
    succeed: succeedWith,
    compose: (projectEnv, args, opts = {}) =>
      run([...spec.compose, ...args], { ...opts, env: projectEnv }),
  };
}

/**
 * The first engine, in the order of engines.mts, that is installed and
 * reachable.
 * @returns That engine; throws when none is usable.
 */
export async function firstUsable(): Promise<Engine> {
  const problems: string[] = [];
  for (const spec of Object.values(engines)) {
    try {
      return await detect(spec);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  throw new Error(`No container engine is usable:\n${problems.join("\n")}`);
}

/**
 * Load the exact layout bytes into an engine under a unique local name.
 * Every engine finds the image by a digest of the layout, so the loaded
 * image cannot be another one that happens to have the same name.
 * @returns The local image name.
 */
export async function load(
  engine: Engine,
  layout: string,
  options: { readonly tag: string; readonly temporary: string },
): Promise<string> {
  const image = await singleImage(layout);
  const copy = await mkdtemp(join(options.temporary, "layout-"));
  await cp(join(layout, "blobs"), join(copy, "blobs"), { recursive: true });
  await cp(join(layout, "oci-layout"), join(copy, "oci-layout"));
  // Only index.json, which is not part of the image, names the image here.
  await writeFile(
    join(copy, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          ...image.descriptor,
          annotations: { "org.opencontainers.image.ref.name": options.tag },
        },
      ],
    }),
  );
  const archive = `${copy}.tar`;
  try {
    // Some engines load only archives, not layout directories.
    await succeed("tar", ["-cf", archive, "-C", copy, "."]);
    await engine.succeed(["load", "--input", archive]);
    const candidates = imageIdCandidates(image);
    let id: string | undefined;
    for (const candidate of candidates) {
      const inspected = await engine.run([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        candidate,
      ]);
      if (inspected.code === 0 && inspected.stdout.trim() !== "") {
        id = normalizeImageId(inspected.stdout);
        break;
      }
    }
    assert.ok(
      id !== undefined && candidates.includes(id),
      `Loaded image ${id} is not the layout image ${image.descriptor.digest}`,
    );
    await engine.succeed(["tag", id, options.tag]);
    return options.tag;
  } finally {
    await rm(copy, { recursive: true, force: true });
    await rm(archive, { force: true });
  }
}

/** What a Compose project was created with, so that it can be taken down. */
export interface ComposeProject {
  /** The project's environment, including its name, files and image. */
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

/** The containers, volumes, Compose projects and image a test run made. */
export interface Resources {
  readonly projects: Map<string, ComposeProject>;
  readonly containers: Set<string>;
  readonly volumes: Set<string>;
  image?: string;
}

export const resources = (): Resources => ({
  projects: new Map(),
  containers: new Set(),
  volumes: new Set(),
});

const failure = (args: readonly string[], result: Result): string =>
  `${args.join(" ")} exited with ${result.code}:\n${result.stderr.trim()}`;

/**
 * Remove a resource unless `inspect` shows that it never existed or is gone.
 * @returns The failure, if removing it failed.
 */
async function removePresent(
  engine: Engine,
  inspect: readonly string[],
  remove: readonly string[],
): Promise<string | undefined> {
  if ((await engine.run(inspect)).code !== 0) return undefined;
  const result = await engine.run(remove);
  return result.code === 0 ? undefined : failure(remove, result);
}

/**
 * The resources that Compose labeled as part of a project and that are still
 * there.
 * @returns One line per kind of resource left behind.
 */
async function composeLeftovers(
  engine: Engine,
  project: string,
): Promise<readonly string[]> {
  const filter = `label=com.docker.compose.project=${project}`;
  const kinds = [
    ["containers", ["ps", "--all", "--quiet", "--filter", filter]],
    ["volumes", ["volume", "ls", "--quiet", "--filter", filter]],
    ["networks", ["network", "ls", "--quiet", "--filter", filter]],
  ] as const;
  const found = await Promise.all(
    kinds.map(async ([kind, args]) => {
      const result = await engine.run(args);
      if (result.code !== 0) return failure(args, result);
      const ids = result.stdout.split("\n").filter((line) => line.trim());
      return ids.length === 0
        ? undefined
        : `Compose project ${project} left ${kind}: ${ids.join(", ")}`;
    }),
  );
  return found.filter((line) => line !== undefined);
}

/**
 * Remove everything a test run registered.  Compose projects are taken down
 * with the environment and directory they were created with, since the
 * Compose files declare their volumes.
 * @returns What could not be removed; empty when everything is gone.
 */
export async function cleanup(
  engine: Engine,
  registered: Resources,
): Promise<readonly string[]> {
  const problems: string[] = [];
  for (const [name, project] of registered.projects) {
    const args = ["down", "--volumes", "--remove-orphans"];
    const down = await engine.compose(project.env, args, {
      cwd: project.cwd,
      timeout: 120_000,
    });
    if (down.code !== 0) problems.push(failure([name, ...args], down));
    problems.push(...(await composeLeftovers(engine, name)));
  }
  for (const container of registered.containers) {
    const problem = await removePresent(
      engine,
      ["container", "inspect", container],
      ["rm", "--force", "--volumes", container],
    );
    if (problem) problems.push(problem);
  }
  for (const volume of registered.volumes) {
    const problem = await removePresent(
      engine,
      ["volume", "inspect", volume],
      ["volume", "rm", "--force", volume],
    );
    if (problem) problems.push(problem);
  }
  if (registered.image) {
    const problem = await removePresent(
      engine,
      ["image", "inspect", registered.image],
      ["image", "rm", "--force", registered.image],
    );
    if (problem) problems.push(problem);
  }
  return problems;
}
