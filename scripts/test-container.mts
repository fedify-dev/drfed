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

// Run the image layout that image:build wrote through the documented
// commands, Compose examples, backup and restore snippets, and an upgrade from
// the previous release.  Every container runs the exact layout bytes.
// oxlint-disable no-console no-await-in-loop max-statements
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import {
  type ImageMetadata,
  architecture,
  baseImage,
  imageAnnotations,
  metadataFile,
  readJson,
  root,
  singleImage,
} from "./image.mts";
import { requestInstalledWeb } from "./smoke-http.mts";

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const temporary = await mkdtemp(join(tmpdir(), "drfed-container-"));
const prefix = `drfed-ci-${process.pid}`;
const projects = new Set<string>();
const volumes = new Set<string>();
const containers = new Set<string>();
const docker = join(root, "docker");

/**
 * Run a command to completion without throwing on its exit status.
 * @returns Its exit code and output.
 */
async function exec(
  command: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly timeout?: number | undefined;
  } = {},
): Promise<Result> {
  const child = spawn(command, args, {
    cwd: options.cwd ?? temporary,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
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

async function succeed(
  command: string,
  args: readonly string[],
  options?: Parameters<typeof exec>[2],
): Promise<Result> {
  const result = await exec(command, args, options);
  assert.equal(
    result.code,
    0,
    `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

const run = (args: readonly string[], options?: Parameters<typeof exec>[2]) =>
  exec("docker", args, options);

/**
 * One Compose project made of the documented files plus the CI override.
 * @returns Helpers bound to that project.
 */
function compose(name: string, files: readonly string[], image: string) {
  const project = `${prefix}-${name}`;
  projects.add(project);
  const env = {
    ...process.env,
    COMPOSE_PROJECT_NAME: project,
    COMPOSE_FILE: files.join(delimiter),
    DRFED_IMAGE: image,
  };
  const call = (args: readonly string[], timeout?: number) =>
    run(["compose", ...args], { env, timeout });
  return {
    env,
    call,
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
      const result = await call(["up", "--detach", service]);
      assert.equal(result.code, 0, result.stderr);
      await this.waitListening(before, service);
    },
    async port(service = "drfed", target = 8888): Promise<number> {
      const result = await call(["port", service, String(target)]);
      assert.equal(result.code, 0, result.stderr);
      const port = Number(
        /:(?<port>\d+)\s*$/u.exec(result.stdout)?.groups?.port,
      );
      assert.ok(port > 0, result.stdout);
      return port;
    },
    async container(service = "drfed"): Promise<string> {
      const result = await call(["ps", "--all", "--quiet", service]);
      assert.equal(result.code, 0, result.stderr);
      const id = result.stdout.trim();
      assert.match(id, /^[a-f0-9]+$/u);
      return id;
    },
  };
}
type Project = ReturnType<typeof compose>;

async function exitCode(container: string): Promise<number> {
  const result = await run([
    "inspect",
    "--format",
    "{{.State.ExitCode}}",
    container,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return Number(result.stdout.trim());
}

/**
 * Create an account the way the documentation does, through `run --rm`.
 * @returns The JSON that `drfed-account create` printed.
 */
async function createAccount(
  project: Project,
  email = "operator@example.com",
): Promise<{ status: string; account: { id: string } }> {
  const result = await project.call([
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
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    status: string;
    account: { id: string };
  };
}

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: unknown;
}
async function graphql(
  port: number,
  host: string,
  query: string,
  variables: Record<string, unknown> = {},
  token?: string,
): Promise<Record<string, unknown>> {
  const response = await requestInstalledWeb(
    port,
    "/graphql",
    {
      host,
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    JSON.stringify({ query, variables }),
  );
  assert.equal(response.status, 200, response.body);
  const body = JSON.parse(response.body) as GraphQLResponse;
  assert.equal(body.errors, undefined, response.body);
  assert.ok(body.data);
  return body.data;
}

async function requestLogin(
  port: number,
  origin: string,
  email = "operator@example.com",
): Promise<string> {
  const data = await graphql(
    port,
    new URL(origin).host,
    `
      mutation Login($email: Email!, $verifyUrl: URITemplate!) {
        loginByEmail(email: $email, verifyUrl: $verifyUrl) {
          challengeId
        }
      }
    `,
    {
      email,
      verifyUrl: `${origin}/login?challengeId={challengeId}&code={code}`,
    },
  );
  const { challengeId } = data.loginByEmail as { challengeId?: string };
  assert.ok(challengeId);
  return challengeId;
}

/**
 * Log in through the link that the logtape mail transport printed.
 * @returns The account UUID the new session belongs to.
 */
async function logIn(
  project: Project,
  port: number,
  origin: string,
): Promise<string> {
  const challengeId = await requestLogin(port, origin);
  const link = await project.waitFor(
    new RegExp(
      `${origin.replaceAll(".", "\\.")}/login\\?challengeId=${challengeId}&(?:amp;)?code=(?<code>[A-Za-z0-9]+)`,
      "u",
    ),
  );
  const { host } = new URL(origin);
  const completed = await graphql(
    port,
    host,
    `
      mutation Complete($challengeId: UUID!, $code: String!) {
        completeLoginChallenge(challengeId: $challengeId, code: $code) {
          accessToken
        }
      }
    `,
    { challengeId, code: link.groups!.code },
  );
  const token = (completed.completeLoginChallenge as { accessToken?: string })
    .accessToken;
  assert.ok(token, "Login completes with an access token.");
  const viewer = await graphql(
    port,
    host,
    "{ viewer { uuid email } }",
    {},
    token,
  );
  const account = viewer.viewer as { uuid: string; email: string };
  assert.equal(account.email, "operator@example.com");
  return account.uuid;
}

async function expectPage(port: number, host: string): Promise<void> {
  const page = await requestInstalledWeb(port, "/", { host });
  assert.equal(page.status, 200);
  assert.match(page.body, /DrFed/u);
  const icon = await requestInstalledWeb(port, "/icon.svg", { host });
  assert.equal(icon.status, 200);
}

/**
 * Load the exact layout bytes into the daemon under a unique name.
 * @returns The local image name.
 */
async function load(layout: string, metadata: ImageMetadata): Promise<string> {
  const { descriptor, manifest } = await singleImage(layout);
  const tag = `${prefix}:candidate`;
  const copy = join(temporary, "layout");
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
          ...descriptor,
          annotations: {
            "io.containerd.image.name": `docker.io/library/${tag}`,
            "org.opencontainers.image.ref.name": "candidate",
          },
        },
      ],
    }),
  );
  const archive = join(temporary, "layout.tar");
  await succeed("tar", ["-cf", archive, "-C", copy, "."]);
  await succeed("docker", ["load", "--input", archive]);
  const inspected = await run([
    "image",
    "inspect",
    "--format",
    "{{.Id}} {{.Os}}/{{.Architecture}}",
    tag,
  ]);
  assert.equal(inspected.code, 0, inspected.stderr);
  const [id, platform] = inspected.stdout.trim().split(" ");
  // The containerd image store keeps the manifest digest; the classic store
  // keeps the config digest, which covers every layer through its diff IDs.
  assert.ok(
    id === descriptor.digest || id === manifest.config.digest,
    `Loaded image ${id} is not the layout image ${descriptor.digest}`,
  );
  assert.equal(platform, metadata.platform);
  await rm(copy, { recursive: true, force: true });
  await rm(archive, { force: true });
  return tag;
}

async function checkCommands(
  image: string,
  metadata: ImageMetadata,
): Promise<void> {
  const labels = await run([
    "image",
    "inspect",
    "--format",
    "{{json .Config.Labels}}",
    image,
  ]);
  assert.deepEqual(JSON.parse(labels.stdout), imageAnnotations(metadata));
  for (const command of [
    "drfed-server",
    "drfed-web",
    "drfed-migrate",
    "drfed-account",
  ]) {
    const version = await succeed("docker", [
      "run",
      "--rm",
      image,
      command,
      "--version",
    ]);
    assert.ok(version.stdout.includes(metadata.build.version), version.stdout);
  }
  const help = async (args: readonly string[]) =>
    (await succeed("docker", ["run", "--rm", image, ...args])).stdout;
  assert.match(await help(["drfed-migrate", "--help"]), /--check/u);
  assert.match(await help(["drfed-web", "--help"]), /--backend-url/u);
  assert.match(await help(["drfed-account", "--help"]), /create/u);
  // Leading options go to drfed-server; no arguments run drfed-server.
  assert.match(await help(["--help"]), /--root-origin/u);
  const missing = await run(["run", "--rm", image]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /root-origin/u);
  assert.equal((await help(["id", "-u"])).trim(), "1000");
  const printed = JSON.parse(
    await help(["--root-origin=http://drfed.test", "--print-config"]),
  ) as { settings: Record<string, { value: unknown; source: string }> };
  assert.deepEqual(printed.settings["server.listen"], {
    value: { host: "0.0.0.0", port: 8888 },
    source: "default",
  });
  assert.equal(
    printed.settings["database.data_path"]?.value,
    "/var/lib/drfed/data",
  );
  const web = JSON.parse(
    await help([
      "drfed-web",
      "--public-origin=http://drfed.test",
      "--backend-url=http://drfed:8888",
      "--allow-insecure-backend",
      "--print-config",
    ]),
  ) as { settings: Record<string, { value: unknown; source: string }> };
  assert.equal(web.settings["web.listen"]?.source, "default");
  assert.match(
    JSON.stringify(web.settings["web.listen"]?.value),
    /0\.0\.0\.0/u,
  );

  const volume = `${prefix}-ownership`;
  volumes.add(volume);
  await succeed("docker", ["volume", "create", volume]);
  const mount = `${volume}:/var/lib/drfed`;
  const check = await run([
    "run",
    "--rm",
    "-v",
    mount,
    image,
    "drfed-migrate",
    "--check",
  ]);
  assert.equal(check.code, 1, check.stderr);
  assert.equal(JSON.parse(check.stdout).status, "uninitialized");
  const owner = await succeed("docker", [
    "run",
    "--rm",
    "-v",
    mount,
    image,
    "stat",
    "-c",
    "%u %a",
    "/var/lib/drfed/data",
  ]);
  assert.equal(owner.stdout.trim(), "1000 700");
  console.log("Commands, entrypoint, labels, user and volume ownership passed");
}

async function checkPglite(image: string): Promise<void> {
  const origin = "http://drfed.localhost:8888";
  const project = compose(
    "pglite",
    [join(docker, "compose.pglite.yaml"), join(docker, "compose.ci.yaml")],
    image,
  );
  try {
    const created = await createAccount(project);
    assert.equal(created.status, "created");
    await project.up();
    let port = await project.port();
    await expectPage(port, new URL(origin).host);
    assert.ok(await logIn(project, port, origin));

    // The documented failure of a second process on the PGlite directory.
    for (const args of [
      ["drfed-account", "create", "--email", "x@example.com", "--name", "X"],
      ["drfed-migrate", "--check"],
    ]) {
      const started = Date.now();
      const locked = await project.call(["run", "--rm", "drfed", ...args]);
      assert.equal(locked.code, 1, locked.stdout);
      assert.match(
        locked.stderr,
        /locked: The PGlite data directory is already in use by another owner\./u,
      );
      assert.ok(Date.now() - started < 15_000, "Lock failure is immediate.");
    }

    const first = await project.container();
    const stopping = Date.now();
    assert.equal((await project.call(["stop", "drfed"])).code, 0);
    assert.ok(Date.now() - stopping < 10_000, "Shutdown beats its deadline.");
    assert.equal(await exitCode(first), 0);
    assert.equal(
      (await project.call(["run", "--rm", "drfed", "drfed-migrate", "--check"]))
        .code,
      0,
    );
    assert.equal(
      (await project.call(["run", "--rm", "drfed", "drfed-migrate"])).code,
      0,
    );

    // A new container on the same volume keeps the data.
    assert.equal((await project.call(["rm", "--force", "drfed"])).code, 0);
    await project.up();
    assert.notEqual(await project.container(), first);
    port = await project.port();
    assert.ok(await logIn(project, port, origin));
    assert.equal((await project.call(["stop", "drfed"])).code, 0);
    const existing = await createAccount(project);
    assert.equal(existing.status, "exists");
    assert.equal(existing.account.id, created.account.id);
    console.log("PGlite example, lock, shutdown and replacement passed");

    await checkBackup(project, image, created.account.id, origin);
  } catch (error) {
    console.error(await project.logs());
    throw error;
  }
}

async function checkBackup(
  project: Project,
  image: string,
  accountId: string,
  origin: string,
): Promise<void> {
  const directory = await mkdtemp(join(temporary, "backup-"));
  const before = await project.listening();
  await succeed("sh", [join(docker, "backup.sh")], {
    cwd: directory,
    env: project.env,
  });
  await project.waitListening(before);
  const restored = compose(
    "restore",
    [join(docker, "compose.pglite.yaml"), join(docker, "compose.ci.yaml")],
    image,
  );
  try {
    await succeed("sh", [join(docker, "restore.sh")], {
      cwd: directory,
      env: restored.env,
    });
    await restored.waitListening(0);
    assert.ok(await logIn(restored, await restored.port(), origin));
    assert.equal((await restored.call(["stop", "drfed"])).code, 0);
    const existing = await createAccount(restored);
    assert.equal(existing.status, "exists");
    assert.equal(existing.account.id, accountId);
    console.log("Backup and restore snippets passed");
  } catch (error) {
    console.error(await restored.logs());
    throw error;
  }
}

async function checkPostgres(image: string): Promise<void> {
  const project = compose(
    "postgres",
    [join(docker, "compose.postgres.yaml"), join(docker, "compose.ci.yaml")],
    image,
  );
  try {
    assert.equal((await project.call(["up", "--detach"], 300_000)).code, 0);
    await project.waitListening(0);
    // No lock: accounts can be created while the server runs.
    const created = await createAccount(project);
    assert.equal(created.status, "created");
    await requestLogin(await project.port(), "https://drfed.example.com");
    const container = await project.container();
    assert.equal((await project.call(["stop", "drfed"])).code, 0);
    assert.equal(await exitCode(container), 0);
    assert.equal(
      (await project.call(["run", "--rm", "drfed", "drfed-migrate", "--check"]))
        .code,
      0,
    );
    console.log("PostgreSQL example passed");
  } catch (error) {
    console.error(await project.logs());
    console.error(await project.logs("postgres"));
    throw error;
  }
}

async function checkSeparateWeb(image: string): Promise<void> {
  const override = join(temporary, "compose.web.ci.yaml");
  await writeFile(
    override,
    `services:
  web:
    image: \${DRFED_IMAGE:?}
    ports: !override
      - "127.0.0.1::3000"
`,
  );
  const project = compose(
    "web",
    [
      join(docker, "compose.pglite.yaml"),
      join(docker, "compose.web.yaml"),
      join(docker, "compose.ci.yaml"),
      override,
    ],
    image,
  );
  try {
    assert.equal((await project.call(["up", "--detach"])).code, 0);
    await project.waitListening(0);
    await project.waitListening(0, "web");
    const backend = await requestInstalledWeb(await project.port(), "/about", {
      host: "drfed.localhost:8888",
    });
    assert.equal(backend.status, 404);
    await expectPage(await project.port("web", 3000), "localhost:3000");
    const container = await project.container("web");
    assert.equal((await project.call(["stop"])).code, 0);
    assert.equal(await exitCode(container), 0);
    console.log("Separate frontend example passed");
  } catch (error) {
    console.error(await project.logs());
    console.error(await project.logs("web"));
    throw error;
  }
}

interface UpgradeSource {
  readonly kind: "npm" | "image";
  readonly package?: string;
  readonly ref?: string;
}

/** Create data with the previous release, then serve it with the candidate. */
async function checkUpgrade(image: string): Promise<void> {
  const source = await readJson<UpgradeSource>(
    join(docker, "upgrade-source.json"),
  );
  const volume = `${prefix}-upgrade`;
  volumes.add(volume);
  // Mounting the candidate first gives the empty volume its node ownership.
  await succeed("docker", ["volume", "create", volume]);
  await succeed("docker", [
    "run",
    "--rm",
    "-v",
    `${volume}:/var/lib/drfed`,
    image,
    "true",
  ]);
  const origin = "http://drfed.localhost:8888";
  // Spelled out because 0.1.0 predates the container defaults.
  const serve = [
    "drfed-account create --data-path /var/lib/drfed/data",
    "--email operator@example.com --name Operator > /tmp/account.json",
    "&& exec drfed-server --data-path /var/lib/drfed/data",
    `--listen 0.0.0.0:8888 --root-origin ${origin} --mail-log-content`,
  ].join(" ");
  const base = await baseImage();
  const previous =
    source.kind === "npm"
      ? [
          "--user",
          "node",
          "--entrypoint",
          "sh",
          `${base.name}@${base.digest}`,
          "-c",
          `set -e; npm install --prefix /home/node/drfed --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --cache /tmp/npm-cache "${source.package}" >&2; PATH=/home/node/drfed/node_modules/.bin:$PATH; ${serve}`,
        ]
      : ["--entrypoint", "sh", source.ref!, "-c", serve];
  const old = `${prefix}-previous`;
  containers.add(old);
  await succeed("docker", [
    "run",
    "--detach",
    "--name",
    old,
    "--publish",
    "127.0.0.1::8888",
    "-v",
    `${volume}:/var/lib/drfed`,
    ...previous,
  ]);
  const logs = async (name: string) => {
    const result = await run(["logs", name]);
    return result.stdout + result.stderr;
  };
  try {
    const deadline = Date.now() + 300_000;
    while (!/Listening on/u.test(await logs(old))) {
      assert.ok(Date.now() < deadline, await logs(old));
      await delay(1000);
    }
    const port = Number(
      /:(?<port>\d+)\s*$/u.exec((await run(["port", old, "8888"])).stdout)
        ?.groups?.port,
    );
    await requestLogin(port, origin);
    assert.equal((await run(["stop", "--time", "20", old])).code, 0);
    assert.equal(await exitCode(old), 0);
    const output = join(temporary, "account.json");
    await succeed("docker", ["cp", `${old}:/tmp/account.json`, output]);
    const created = await readJson<{
      status: string;
      account: { id: string };
    }>(output);
    assert.equal(created.status, "created");
    const accountId = created.account.id;

    const project = compose(
      "upgrade",
      [join(docker, "compose.pglite.yaml"), join(docker, "compose.ci.yaml")],
      image,
    );
    const override = join(temporary, "compose.upgrade.yaml");
    await writeFile(
      override,
      `volumes:\n  drfed-data:\n    name: ${volume}\n    external: true\n`,
    );
    project.env.COMPOSE_FILE += `${delimiter}${override}`;
    try {
      await project.up();
      assert.equal((await project.call(["stop", "drfed"])).code, 0);
      assert.equal(
        (
          await project.call([
            "run",
            "--rm",
            "drfed",
            "drfed-migrate",
            "--check",
          ])
        ).code,
        0,
      );
      const existing = await createAccount(project);
      assert.equal(existing.status, "exists");
      assert.equal(existing.account.id, accountId);
      await project.up();
      assert.ok(await logIn(project, await project.port(), origin));
      console.log(
        `Upgrade from ${source.package ?? source.ref} to the candidate passed`,
      );
    } catch (error) {
      console.error(await project.logs());
      throw error;
    }
  } catch (error) {
    console.error(await logs(old));
    throw error;
  }
}

async function cleanup(image: string | undefined): Promise<void> {
  for (const project of projects) {
    await run(
      [
        "compose",
        "--project-name",
        project,
        "down",
        "--volumes",
        "--remove-orphans",
      ],
      {
        timeout: 120_000,
      },
    );
  }
  for (const container of containers) {
    await run(["rm", "--force", "--volumes", container]);
  }
  for (const volume of volumes) await run(["volume", "rm", "--force", volume]);
  if (image) await run(["image", "rm", "--force", image]);
  await rm(temporary, { recursive: true, force: true });
}

let image: string | undefined;
try {
  const info = await run(["info", "--format", "{{.ServerVersion}}"]);
  if (info.code !== 0) {
    throw new Error(
      `The Docker daemon is unavailable, so no container check ran:\n${info.stderr}`,
    );
  }
  await succeed("docker", ["compose", "version"]);
  const server = await succeed("docker", [
    "version",
    "--format",
    "{{.Server.Os}}/{{.Server.Arch}}",
  ]);
  const layout = resolve(
    process.env.usage_layout ??
      join(
        root,
        "image-artifacts",
        `linux-${architecture(server.stdout.trim())}`,
      ),
  );
  const metadata = await readJson<ImageMetadata>(join(layout, metadataFile));
  assert.equal(metadata.platform, server.stdout.trim(), "Foreign platform");
  image = await load(layout, metadata);
  await checkCommands(image, metadata);
  await checkPglite(image);
  await checkPostgres(image);
  await checkSeparateWeb(image);
  await checkUpgrade(image);
  console.log(`All container checks passed for ${metadata.build.version}`);
} finally {
  await cleanup(image);
}
