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
// Pack and install serially to bound resource use; restarts share one database.
// oxlint-disable no-console node/no-top-level-await no-await-in-loop
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { type IncomingHttpHeaders, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  join,
  relative,
  resolve,
} from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { probeCompletionInstallation } from "./completion-installation.mts";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "drfed-packaging-"));
const artifactArgument = process.argv.indexOf("--artifacts");
const suppliedArtifacts =
  artifactArgument >= 0
    ? resolve(process.argv[artifactArgument + 1]!)
    : undefined;
const packages = ["models", "federation", "graphql", "web", "drfed"];
const windows = process.platform === "win32";
const probeShells = process.env.DRFED_TEST_COMPLETION_SHELLS === "1";
const npm = windows
  ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
  : resolve(
      dirname(process.execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    );
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^npm_config_/iu.test(key) &&
      !/^DRFED_/iu.test(key) &&
      !["NODE_OPTIONS", "NODE_PATH", "TEST"].includes(key),
  ),
);
const pathKey =
  Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ""}`;
env.npm_config_cache = join(temporary, "cache");
env.npm_config_userconfig = join(temporary, "npmrc");
env.npm_config_globalconfig = join(temporary, "global-npmrc");
env.npm_config_registry = "https://registry.npmjs.org/";

interface Manifest {
  name: string;
  version: string;
  main: string;
  types: string;
  dependencies?: Record<string, string>;
  exports?: unknown;
  bin?: Record<string, string>;
}

async function run(command: string, args: string[], cwd: string) {
  return await execute(command, args, {
    cwd,
    env,
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function smokeMigration(
  binary: string,
  cwd: string,
  dataPath: string,
  migrationCount: number,
) {
  const config = join(cwd, "migrate.toml");
  await writeFile(
    config,
    `[database]\ndata_path = ${JSON.stringify(dataPath)}\nmigrate = false\n`,
  );
  await assert.rejects(
    run(process.execPath, [binary, "--config", config, "--check"], cwd),
    (error: unknown) => {
      const result = error as { code?: number; stdout?: string };
      return (
        result.code === 1 &&
        JSON.parse(result.stdout ?? "{}").status === "uninitialized"
      );
    },
  );
  const applied = await run(
    process.execPath,
    [binary, "--config", config],
    cwd,
  );
  assert.equal(JSON.parse(applied.stdout).status, "ready");
  const checked = await run(
    process.execPath,
    [binary, "--config", config, "--check"],
    cwd,
  );
  assert.equal(JSON.parse(checked.stdout).status, "ready");
  assert.equal(JSON.parse(checked.stdout).applied, migrationCount);
}

function completionFiles(
  command: string,
): readonly (readonly [string, string])[] {
  return [
    ["bash", command],
    ["zsh", `_${command}`],
    ["fish", `${command}.fish`],
    ["pwsh", `${command}.ps1`],
    ["nu", `${command}.nu`],
  ];
}

async function smokeCompletion(
  application: string,
  prefix: string,
  modules: string,
  global: boolean,
) {
  for (const command of [
    "drfed-server",
    "drfed-web",
    "drfed-migrate",
    "drfed-account",
  ]) {
    const linked = global
      ? join(prefix, windows ? `${command}.cmd` : `bin/${command}`)
      : join(modules, ".bin", windows ? `${command}.cmd` : command);
    const invoke = (args: string[]) =>
      windows
        ? run(
            process.execPath,
            [
              npm,
              "exec",
              "--offline",
              ...(global ? ["--global", "--prefix", prefix] : []),
              "--",
              command,
              ...args,
            ],
            prefix,
          )
        : run(linked, args, prefix);
    for (const [shell, filename] of completionFiles(command)) {
      // oxlint-disable-next-line no-await-in-loop
      const generated = await invoke(["completion", shell]);
      assert.equal(generated.stderr, "");
      assert.ok(
        generated.stdout.trim().length > 0,
        `Empty generated ${shell} completion for ${command}`,
      );
      // Bundled files belong to the installed package, independent of cwd.
      // oxlint-disable-next-line no-await-in-loop
      const bundled = await readFile(
        join(application, "completions", shell, filename),
        "utf8",
      );
      assert.ok(
        bundled.trim().length > 0,
        `Empty bundled ${shell} completion for ${command}`,
      );
      const option =
        command === "drfed-web" ? "--public-origin" : "--data-path";
      // oxlint-disable-next-line no-await-in-loop
      const suggestions = await invoke([
        "--completion",
        shell,
        ...(command === "drfed-account" ? ["create"] : []),
        option.slice(0, -2),
      ]);
      assert.equal(suggestions.stderr, "");
      assert.ok(suggestions.stdout.includes(option), `${command}: ${shell}`);
      if (command === "drfed-server") {
        // oxlint-disable-next-line no-await-in-loop
        const values = await invoke([
          "completion",
          shell,
          "--mail-transport=re",
        ]);
        assert.equal(values.stderr, "");
        assert.ok(values.stdout.includes("resend"));
        assert.ok(!values.stdout.includes("smtp"));
      }
      if (command === "drfed-account") {
        // oxlint-disable-next-line no-await-in-loop
        const subcommands = await invoke(["completion", shell, "cr"]);
        assert.equal(subcommands.stderr, "");
        assert.ok(subcommands.stdout.includes("create"));
      }
    }
  }
}

async function pack(name: string) {
  let archive: string;
  let paths: string[];
  if (suppliedArtifacts) {
    const bundle = JSON.parse(
      await readFile(join(suppliedArtifacts, "manifest.json"), "utf8"),
    ) as { packages: { name: string; filename: string }[] };
    const entry = bundle.packages.find(
      (item) => item.name === `@drfed/${name}`,
    );
    assert.ok(entry);
    assert.equal(entry.filename, basename(entry.filename));
    archive = join(suppliedArtifacts, entry.filename);
    const listing = await run("tar", ["-tzf", archive], temporary);
    paths = listing.stdout
      .trim()
      .split("\n")
      .map((path) => path.replace(/^package\//u, ""));
  } else {
    const { stdout } = await run(
      "pnpm",
      ["pack", "--json", "--pack-destination", temporary],
      join(root, "packages", name),
    );
    const result = JSON.parse(stdout) as {
      filename: string;
      files: { path: string }[];
    };
    archive = resolve(temporary, result.filename);
    paths = result.files.map(({ path }) => path);
  }
  const packed = await run(
    "tar",
    ["-xOf", archive, "package/package.json"],
    temporary,
  );
  const manifest = JSON.parse(packed.stdout) as Manifest;
  const source = JSON.parse(
    await readFile(join(root, "packages", name, "package.json"), "utf8"),
  ) as Manifest;
  assert.equal(manifest.name, source.name);
  assert.equal(manifest.version, source.version);
  for (const version of Object.values(manifest.dependencies ?? {})) {
    assert.ok(!/^(?:workspace:|catalog:|file:|link:)/u.test(version), version);
  }
  const files = new Set(paths);
  function checkTargets(value: unknown): void {
    if (typeof value === "string") {
      assert.ok(
        files.has(value.replace(/^\.\//u, "")),
        `Missing packed entry: ${value}`,
      );
    } else if (value != null && typeof value === "object") {
      Object.values(value).forEach(checkTargets);
    }
  }
  checkTargets(manifest.main);
  checkTargets(manifest.types);
  checkTargets(manifest.exports);
  checkTargets(manifest.bin);
  assert.ok(![...files].some((path) => path.startsWith("src/")));
  if (name === "drfed") {
    for (const command of Object.keys(manifest.bin ?? {})) {
      for (const [shell, filename] of completionFiles(command)) {
        assert.ok(
          files.has(`completions/${shell}/${filename}`),
          `Missing packed completion: ${shell}/${filename}`,
        );
      }
    }
  }
  if (name === "models") {
    assert.ok(files.has("dist/migrations-manifest.json"));
    const migrations = await readdir(join(root, "packages/models/drizzle"), {
      recursive: true,
    });
    const sql = migrations.filter((path) => path.endsWith(".sql"));
    assert.ok(sql.length > 0);
    for (const path of sql) {
      assert.ok(
        files.has(`drizzle/${path.replaceAll("\\", "/")}`),
        `Missing packed migration: ${path}`,
      );
    }
  }
  console.log(`Packed ${manifest.name}@${manifest.version}`);
  return { archive, manifest };
}

interface WebSmokeResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
async function requestInstalledWeb(
  port: number,
  path: string,
  headers: Readonly<Record<string, string>> = {},
  body?: string,
): Promise<WebSmokeResponse> {
  const result = Promise.withResolvers<WebSmokeResponse>();
  const request = httpRequest(
    {
      hostname: "127.0.0.1",
      port,
      path,
      method: body === undefined ? "GET" : "POST",
      headers: { host: "drfed.test", ...headers },
    },
    (response) => {
      let output = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        output += chunk;
      });
      response.once("end", () =>
        result.resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: output,
        }),
      );
      response.once("error", result.reject);
    },
  );
  request.once("error", result.reject);
  request.setTimeout(10_000, () =>
    request.destroy(new Error("Installed web request timed out.")),
  );
  request.end(body);
  return await result.promise;
}
interface CrossJsonModule {
  readonly toCrossJSON: (value: unknown) => unknown;
}
function isCrossJsonModule(value: unknown): value is CrossJsonModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "toCrossJSON" in value &&
    typeof value.toCrossJSON === "function"
  );
}
async function verifyInstalledWeb(
  modules: string,
  webPort: number,
  backendPort: number,
  challengeId: string,
  logFile: string,
): Promise<void> {
  const page = await requestInstalledWeb(webPort, "/about");
  assert.equal(page.status, 200);
  assert.match(page.body, /DrFed/u);
  const asset = await requestInstalledWeb(webPort, "/icon.svg");
  assert.equal(asset.status, 200);
  assert.match(asset.body, /<svg/u);
  let code: string | undefined;
  const pattern = new RegExp(
    `challengeId=${challengeId}&(?:amp;)?code=(?<code>[A-Za-z0-9]+)`,
    "u",
  );
  // The blocking file sink flushes on a record after its five-second interval.
  const mailDeadline = Date.now() + 10_000;
  while (code === undefined && Date.now() < mailDeadline) {
    code = pattern.exec(await readFile(logFile, "utf8"))?.groups?.code;
    if (code === undefined) {
      await delay(250);
      // Keep producing public query logs so the buffered mail record flushes.
      const probe = await fetch(`http://127.0.0.1:${backendPort}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(probe.status, 200);
      await probe.arrayBuffer();
    }
  }
  assert.ok(code !== undefined, "Login mail contains its verification code.");
  const webPackage = join(modules, "@drfed/web");
  const bundle = await readFile(
    join(webPackage, ".output/server/_ssr/ssr.mjs"),
    "utf8",
  );
  const id =
    /completeLoginChallengeMutation = [^;]+;[\s\S]*?createServerReference\("(?<id>[^"]+)"/u.exec(
      bundle,
    )?.groups?.id;
  assert.ok(id !== undefined, "Installed login action is registered.");
  const serializer: unknown = await import(
    pathToFileURL(
      createRequire(join(webPackage, "package.json")).resolve("seroval"),
    ).href
  );
  assert.ok(isCrossJsonModule(serializer));
  const payload = JSON.stringify(
    serializer.toCrossJSON([{ challengeId, code }]),
  );
  const body = `;0x${new TextEncoder().encode(payload).length.toString(16).padStart(8, "0")};${payload}`;
  const path = `/_server?id=${id}`;
  const headers = { "x-start-type": "0", "x-server-instance": "installed" };
  const denied = await requestInstalledWeb(
    webPort,
    path,
    { ...headers, origin: "http://instance.drfed.test" },
    body,
  );
  assert.equal(denied.status, 403);
  const confirmed = await requestInstalledWeb(
    webPort,
    path,
    { ...headers, origin: "http://drfed.test" },
    body,
  );
  assert.equal(confirmed.status, 200);
  const cookie = confirmed.headers["set-cookie"]?.find((value) =>
    value.startsWith("session="),
  );
  assert.ok(
    cookie !== undefined,
    "Installed login confirmation sets a session cookie.",
  );
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /SameSite=Lax/u);
  const authenticated = await requestInstalledWeb(webPort, "/about", {
    cookie: cookie.split(";")[0] ?? "",
  });
  assert.equal(authenticated.status, 200);
  assert.match(authenticated.body, /Operator/u);
}

async function smokeInstalledWeb(
  binary: string,
  modules: string,
  backendPort: number,
  cwd: string,
  challengeId: string,
  logFile: string,
): Promise<void> {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address !== null && typeof address !== "string");
  await socket[Symbol.asyncDispose]();
  const child = spawn(
    process.execPath,
    [
      binary,
      "--public-origin=http://drfed.test",
      `--backend-url=http://127.0.0.1:${backendPort}`,
      `--listen=127.0.0.1:${address.port}`,
      "--log-level=error",
    ],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<{
    code: number | null;
    signal: string | null;
  }>();
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes("Listening on:")) ready.resolve();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.once("error", ready.reject);
  child.once("close", (code, signal) => {
    ready.reject(new Error("Installed web exited before readiness."));
    closed.resolve({ code, signal });
  });
  const startupTimer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    await ready.promise;
    clearTimeout(startupTimer);
    await verifyInstalledWeb(
      modules,
      address.port,
      backendPort,
      challengeId,
      logFile,
    );
  } finally {
    clearTimeout(startupTimer);
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const result = await closed.promise;
      if (!windows) assert.deepEqual(result, { code: 0, signal: null }, output);
    } finally {
      clearTimeout(timer);
    }
  }
}

// oxlint-disable-next-line max-statements
async function smoke(
  binary: string,
  cwd: string,
  dataPath: string,
  migrate: boolean,
  loginEmail = "unknown@example.com",
  web?: {
    readonly binary: string;
    readonly modules: string;
    readonly combined?: boolean;
  },
) {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address != null && typeof address !== "string");
  await socket[Symbol.asyncDispose]();
  const configDirectory = join(cwd, "configuration");
  await mkdir(configDirectory, { recursive: true });
  const configFile = join(configDirectory, "drfed.toml");
  const configuredDatabase = migrate
    ? `data_path = ${JSON.stringify(relative(configDirectory, dataPath).replaceAll("\\", "/"))}`
    : 'url = "not a URL PRIVATE_TOKEN"';
  await writeFile(
    configFile,
    `[server]
root_origin = "http://drfed.test"
listen = "127.0.0.1:1"
login_origins = ["http://drfed.test"]
[database]
${configuredDatabase}
migrate = false
[mail]
transport = "logtape"
[telemetry]
log_level = "trace"
log_output = "server.log"
`,
  );
  const diagnostic = await run(
    process.execPath,
    [binary, "--config", configFile, "--print-config", "--data-path", dataPath],
    cwd,
  );
  const printed = JSON.parse(diagnostic.stdout);
  assert.equal(printed.command, "server");
  assert.equal(printed.settings["database.driver"].value, "pglite");
  assert.equal(printed.settings["database.driver"].source, "cli");
  assert.equal(
    printed.settings["telemetry.log_output"].value,
    join(configDirectory, "server.log"),
  );
  assert.doesNotMatch(diagnostic.stdout + diagnostic.stderr, /PRIVATE_TOKEN/u);
  const child = spawn(
    process.execPath,
    [
      binary,
      ...(web !== undefined && !web.combined ? ["--no-web"] : []),
      "--mail-log-content",
      ...(migrate ? ["--config", configFile] : ["--no-migrate"]),
    ],
    {
      cwd,
      env: {
        ...env,
        DRFED_CONFIG: migrate ? join(cwd, "missing.toml") : configFile,
        DRFED_LISTEN: `127.0.0.1:${address.port}`,
        DRFED_MIGRATE: "true",
        ...(migrate ? {} : { DRFED_DATA_PATH: dataPath }),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      killSignal: "SIGKILL",
    },
  );
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<{
    code: number | null;
    signal: string | null;
  }>();
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-65_536);
    if (output.includes("Listening on:")) ready.resolve();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-65_536);
  });
  child.once("error", ready.reject);
  child.once("close", (code, signal) => {
    ready.reject(
      new Error(
        `Installed CLI exited before readiness (${code}, ${signal}): ${output}`,
      ),
    );
    closed.resolve({ code, signal });
  });
  let result;
  let challengeId: string | undefined;
  try {
    await ready.promise;
    const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        query: `mutation Login($email: Email!, $verifyUrl: URITemplate!) {
          loginByEmail(email: $email, verifyUrl: $verifyUrl) { challengeId }
        }`,
        variables: {
          email: loginEmail,
          verifyUrl:
            "http://drfed.test/verify?challengeId={challengeId}&code={code}",
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.errors, undefined, JSON.stringify(body));
    assert.ok(body.data.loginByEmail.challengeId);
    challengeId = body.data.loginByEmail.challengeId;
    const page = await requestInstalledWeb(address.port, "/about");
    if (web !== undefined && !web.combined) {
      assert.equal(page.status, 404);
      assert.equal(
        (await requestInstalledWeb(address.port, "/graphql/")).status,
        404,
      );
    } else {
      assert.equal(page.status, 200);
      assert.match(page.body, /DrFed/u);
      assert.equal(
        (await requestInstalledWeb(address.port, "/icon.svg")).status,
        200,
      );
    }
    if (web !== undefined && challengeId !== undefined) {
      if (web.combined) {
        await verifyInstalledWeb(
          web.modules,
          address.port,
          address.port,
          challengeId,
          join(configDirectory, "server.log"),
        );
      } else {
        await smokeInstalledWeb(
          web.binary,
          web.modules,
          address.port,
          cwd,
          challengeId,
          join(configDirectory, "server.log"),
        );
      }
    }
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      result = await closed.promise;
    } finally {
      clearTimeout(timer);
    }
  }
  assert.match(
    await readFile(join(configDirectory, "server.log"), "utf8"),
    /select|insert/iu,
  );
  if (!windows) assert.deepEqual(result, { code: 0, signal: null }, output);
  return challengeId;
}

try {
  await writeFile(env.npm_config_userconfig, "");
  await writeFile(env.npm_config_globalconfig, "");
  const packed = [];
  for (const name of packages) packed.push(await pack(name));
  for (const global of [false, true]) {
    const prefix = join(temporary, global ? "global" : "local");
    await mkdir(prefix);
    await writeFile(
      join(prefix, "package.json"),
      '{"private":true,"type":"module"}',
    );
    await run(
      process.execPath,
      [
        npm,
        "install",
        ...(global ? ["--global", "--prefix", prefix] : []),
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...packed.map(({ archive }) => archive),
      ],
      prefix,
    );
    const modules =
      global && !windows
        ? join(prefix, "lib/node_modules")
        : join(prefix, "node_modules");
    const application = join(modules, "@drfed/drfed");
    await smokeCompletion(application, prefix, modules, global);
    if (probeShells) {
      await probeCompletionInstallation(
        application,
        global ? join(prefix, "bin") : join(modules, ".bin"),
        join(temporary, global ? "global-shells" : "local-shells"),
        env,
      );
      console.log(
        `${global ? "Global" : "Local"} npm install: shell discovery and explicit loading probes passed`,
      );
    }
    console.log(
      `${global ? "Global" : "Local"} npm install: bundled completion and all five suggestion protocols passed`,
    );
    for (const commandName of ["server", "web", "migrate", "account"]) {
      const installedVersion = await run(
        process.execPath,
        [join(application, `bin/drfed-${commandName}.mjs`), "--version"],
        prefix,
      );
      const sourceVersion = JSON.parse(
        await readFile(join(root, "packages/drfed/package.json"), "utf8"),
      ).version as string;
      assert.ok(
        installedVersion.stdout.includes(sourceVersion),
        installedVersion.stdout,
      );
    }
    const require = createRequire(join(application, "package.json"));
    for (const { manifest } of packed) {
      const installed = JSON.parse(
        await readFile(join(modules, manifest.name, "package.json"), "utf8"),
      );
      assert.equal(installed.version, manifest.version);
      if (manifest.name !== "@drfed/drfed") {
        assert.equal(
          await realpath(require.resolve(manifest.name)),
          await realpath(join(modules, manifest.name, manifest.main)),
        );
      }
    }
    const verification = await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { verifyMigrationManifest } from ${JSON.stringify(pathToFileURL(join(modules, "@drfed/models/dist/migration-manifest.mjs")).href)}; await verifyMigrationManifest();`,
      ],
      prefix,
    );
    assert.equal(verification.stderr, "");
    const binary = join(application, "bin/drfed-server.mjs");
    const linked = global
      ? join(prefix, windows ? "drfed-server.cmd" : "bin/drfed-server")
      : join(modules, ".bin", windows ? "drfed-server.cmd" : "drfed-server");
    if (!windows) assert.equal(await realpath(linked), await realpath(binary));
    else {
      assert.ok((await readFile(linked, "utf8")).includes("drfed-server.mjs"));
    }
    const help = windows
      ? await run(
          process.execPath,
          [
            npm,
            "exec",
            "--offline",
            ...(global ? ["--global", "--prefix", prefix] : []),
            "--",
            "drfed-server",
            "--help",
          ],
          prefix,
        )
      : await run(linked, ["--help"], prefix);
    assert.ok(help.stdout.includes("--root-origin"));
    const migrationBinary = join(application, "bin/drfed-migrate.mjs");
    const migrationLink = global
      ? join(prefix, windows ? "drfed-migrate.cmd" : "bin/drfed-migrate")
      : join(modules, ".bin", windows ? "drfed-migrate.cmd" : "drfed-migrate");
    if (!windows) {
      assert.equal(
        await realpath(migrationLink),
        await realpath(migrationBinary),
      );
      assert.ok(
        (await run(migrationLink, ["--help"], prefix)).stdout.includes(
          "--check",
        ),
      );
    } else {
      assert.ok(
        (await readFile(migrationLink, "utf8")).includes("drfed-migrate.mjs"),
      );
      const migrationHelp = await run(
        process.execPath,
        [
          npm,
          "exec",
          "--offline",
          ...(global ? ["--global", "--prefix", prefix] : []),
          "--",
          "drfed-migrate",
          "--help",
        ],
        prefix,
      );
      assert.ok(migrationHelp.stdout.includes("--check"));
    }
    const installedMigrations = JSON.parse(
      await readFile(
        join(modules, "@drfed/models/dist/migrations-manifest.json"),
        "utf8",
      ),
    ) as { migrations: unknown[] };
    await smokeMigration(
      migrationBinary,
      prefix,
      join(prefix, "migration-data"),
      installedMigrations.migrations.length,
    );
    const webBinary = join(application, "bin/drfed-web.mjs");
    const webLink = global
      ? join(prefix, windows ? "drfed-web.cmd" : "bin/drfed-web")
      : join(modules, ".bin", windows ? "drfed-web.cmd" : "drfed-web");
    if (!windows) {
      assert.equal(await realpath(webLink), await realpath(webBinary));
      assert.match(
        (await run(webLink, ["--help"], prefix)).stdout,
        /--backend-url/u,
      );
    } else {
      assert.match(await readFile(webLink, "utf8"), /drfed-web.mjs/u);
      assert.match(
        (
          await run(
            process.execPath,
            [
              npm,
              "exec",
              "--offline",
              ...(global ? ["--global", "--prefix", prefix] : []),
              "--",
              "drfed-web",
              "--help",
            ],
            prefix,
          )
        ).stdout,
        /--backend-url/u,
      );
    }
    const accountBinary = join(application, "bin/drfed-account.mjs");
    const accountLink = global
      ? join(prefix, windows ? "drfed-account.cmd" : "bin/drfed-account")
      : join(modules, ".bin", windows ? "drfed-account.cmd" : "drfed-account");
    if (!windows) {
      assert.equal(await realpath(accountLink), await realpath(accountBinary));
      assert.ok(
        (await run(accountLink, ["--help"], prefix)).stdout.includes("create"),
      );
    } else {
      assert.ok(
        (await readFile(accountLink, "utf8")).includes("drfed-account.mjs"),
      );
      const accountHelp = await run(
        process.execPath,
        [
          npm,
          "exec",
          "--offline",
          ...(global ? ["--global", "--prefix", prefix] : []),
          "--",
          "drfed-account",
          "--help",
        ],
        prefix,
      );
      assert.ok(accountHelp.stdout.includes("create"));
    }
    await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import assert from "node:assert/strict";
import { Server } from "node:net";
Server.prototype.listen = function () { throw new Error("Unexpected web listener"); };
const { createWebRuntime } = await import(${JSON.stringify(pathToFileURL(join(modules, "@drfed/web/dist/runtime.mjs")).href)});
const web = await createWebRuntime({ publicOrigin: new URL("https://drfed.test"), graphqlFetch: () => Response.json({ data: { viewer: null } }) });
try {
  const page = await web.fetch(new Request("https://drfed.test/about"));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /DrFed/);
  const asset = await web.fetch(new Request("https://drfed.test/icon.svg"));
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /<svg/);
} finally { await web.close(); }
`,
      ],
      prefix,
    );
    const dataPath = join(prefix, "data");
    await smoke(binary, prefix, dataPath, true);
    const accountArgs = [
      accountBinary,
      "create",
      "--data-path",
      dataPath,
      "--email=operator@example.com",
      "--name=Operator",
      "--no-migrate",
    ];
    const createdAccount = JSON.parse(
      (await run(process.execPath, accountArgs, prefix)).stdout,
    );
    assert.equal(createdAccount.status, "created");
    assert.equal(createdAccount.account.admin, false);
    const existingAccount = JSON.parse(
      (await run(process.execPath, accountArgs, prefix)).stdout,
    );
    assert.equal(existingAccount.status, "exists");
    assert.equal(existingAccount.account.id, createdAccount.account.id);
    await smoke(binary, prefix, dataPath, false, "operator@example.com", {
      binary: webBinary,
      modules,
      combined: true,
    });
    const challengeId = await smoke(
      binary,
      prefix,
      dataPath,
      false,
      "operator@example.com",
      { binary: webBinary, modules },
    );
    assert.ok(challengeId);
    await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import assert from "node:assert/strict";
import { openPersistentPglite } from ${JSON.stringify(pathToFileURL(join(modules, "@drfed/models/dist/pglite-store.mjs")).href)};
const store = await openPersistentPglite(${JSON.stringify(dataPath)});
try {
  await store.ready;
  const result = await store.client.query("SELECT account_id FROM login_challenges WHERE id=$1", [${JSON.stringify(challengeId)}]);
  assert.equal(result.rows[0]?.account_id, ${JSON.stringify(createdAccount.account.id)});
} finally { await store.close(); }
`,
      ],
      prefix,
    );
    console.log(
      `${global ? "Global" : "Local"} npm install: bin, GraphQL, migration and persistent restart passed`,
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
