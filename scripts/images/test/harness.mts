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

// What every container scenario shares: the run context, Compose projects
// made of the documented files, and the account and exit code helpers.
// oxlint-disable no-await-in-loop
import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { type Engine, type Resources, assertSucceeded } from "../engine.mts";
import { type ImageMetadata, root } from "../layout.mts";

/** One test run against one engine. */
export interface Context {
  readonly temporary: string;
  /** The prefix of every project, container and volume name. */
  readonly prefix: string;
  readonly resources: Resources;
  readonly metadata: ImageMetadata;
}

/** A scenario runs the image under test with one engine. */
export type Scenario = (
  engine: Engine,
  context: Context,
  image: string,
) => Promise<void>;

export const examples = join(root, "docker");

/**
 * The documented Compose files for a scenario, plus the CI override.
 * @returns Their paths.
 */
export const composeFiles = (
  ...files: readonly string[]
): readonly string[] => [
  ...files.map((file) => join(examples, file)),
  join(examples, "compose.ci.yaml"),
];

/**
 * One Compose project made of the given files.
 * @returns Helpers bound to that project.
 */
export function compose(
  engine: Engine,
  context: Context,
  name: string,
  files: readonly string[],
  image: string,
) {
  const project = `${context.prefix}-${name}`;
  const env = engine.env({
    COMPOSE_PROJECT_NAME: project,
    COMPOSE_FILE: files.join(delimiter),
    DRFED_IMAGE: image,
  });
  // The same object, so that files a scenario adds later are taken down too.
  context.resources.projects.set(project, { env, cwd: context.temporary });
  const call = (args: readonly string[], timeout?: number) =>
    engine.compose(env, args, { cwd: context.temporary, timeout });
  const succeed = async (args: readonly string[], timeout?: number) => {
    const result = await call(args, timeout);
    assertSucceeded(
      engine.spec.binary,
      [...engine.spec.compose, ...args],
      result,
    );
    return result;
  };
  return {
    env,
    call,
    succeed,
    async logs(service = "drfed"): Promise<string> {
      const result = await call(["logs", "--no-color", service]);
      return result.stdout + result.stderr;
    },
    async waitFor(
      pattern: RegExp,
      service = "drfed",
    ): Promise<RegExpExecArray> {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const match = pattern.exec(await this.logs(service));
        if (match) return match;
        await delay(500);
      }
      throw new Error(`Timed out waiting for ${pattern} in ${service}`);
    },
    // How often the service has started listening, across restarts.
    async listening(service = "drfed"): Promise<number> {
      return (await this.logs(service)).match(/Listening on/gu)?.length ?? 0;
    },
    /** Wait for a start after `before`; restarts keep their older logs. */
    async waitListening(before: number, service = "drfed"): Promise<void> {
      const deadline = Date.now() + 60_000;
      while ((await this.listening(service)) <= before) {
        assert.ok(Date.now() < deadline, `${service} did not start listening`);
        await delay(500);
      }
    },
    async up(service = "drfed"): Promise<void> {
      const before = await this.listening(service);
      await succeed(["up", "--detach", service]);
      await this.waitListening(before, service);
    },
    async port(service = "drfed", target = 8888): Promise<number> {
      const result = await succeed(["port", service, String(target)]);
      return publishedPort(result.stdout);
    },
    async container(service = "drfed"): Promise<string> {
      const result = await succeed(["ps", "--all", "--quiet", service]);
      const id = result.stdout.trim();
      assert.match(id, /^[a-f0-9]+$/u);
      return id;
    },
  };
}
export type Project = ReturnType<typeof compose>;

/**
 * The host port in what `port` prints, such as `127.0.0.1:49153`.
 * @returns The port number.
 */
export function publishedPort(printed: string): number {
  const port = Number(/:(?<port>\d+)\s*$/u.exec(printed)?.groups?.port);
  assert.ok(port > 0, printed);
  return port;
}

export async function exitCode(
  engine: Engine,
  container: string,
): Promise<number> {
  const result = await engine.succeed([
    "inspect",
    "--format",
    "{{.State.ExitCode}}",
    container,
  ]);
  return Number(result.stdout.trim());
}

/**
 * Create an account the way the documentation does, through `run --rm`.
 * @returns The JSON that `drfed-account create` printed.
 */
export async function createAccount(
  project: Project,
  email = "operator@example.com",
): Promise<{ status: string; account: { id: string } }> {
  const result = await project.succeed([
    "run",
    "--rm",
    "drfed",
    "drfed-account",
    "create",
    "--email",
    email,
    "--name",
    "Operator",
  ]);
  return JSON.parse(result.stdout) as {
    status: string;
    account: { id: string };
  };
}
