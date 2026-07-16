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

// oxlint-disable no-console no-magic-numbers eslin/max-lines
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

interface ExitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

interface ShutdownOptions {
  readonly skipServer?: boolean;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");
const isWindows = process.platform === "win32";
const pnpm = isWindows ? "pnpm.cmd" : "pnpm";

/**
 * Filter packages that should be build with tsdown
 * @returns packages with tsdown dev dep.
 */
async function getTsdownPackages() {
  const packages = await readdir(packagesDir, { withFileTypes: true });
  const packageDirs = packages.filter((entry) => entry.isDirectory());

  const packageChecks = await Promise.all(
    packageDirs.map(async (entry) => {
      const fullPath = join(entry.parentPath, entry.name, "package.json");

      try {
        const packageText = await readFile(fullPath, "utf8");
        const packageData = JSON.parse(packageText) satisfies {
          readonly tsdown?: unknown;
          readonly scripts?: Record<string, string>;
          readonly devDependencies?: Record<string, string>;
        };

        return {
          entry,
          usesTsdown:
            packageData.tsdown != null ||
            packageData.scripts?.build === "tsdown" ||
            packageData.devDependencies?.tsdown != null,
        };
      } catch {
        return {
          entry,
          usesTsdown: false,
        };
      }
    }),
  );

  return packageChecks
    .filter((result) => result.usesTsdown)
    .map((result) => result.entry);
}

async function removeDistDirs() {
  const packages = await getTsdownPackages();
  await Promise.all(
    packages.map((entry) =>
      rm(join(packagesDir, entry.name, "dist"), {
        force: true,
        recursive: true,
      }),
    ),
  );
}

function spawnManaged(
  command: string,
  args: readonly string[],
  cwd: string,
): ChildProcess {
  return spawn(command, args, {
    cwd,
    detached: !isWindows,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
}

async function waitForBuilds(buildExit: Promise<ExitResult>): Promise<void> {
  let buildExitResult: ExitResult | undefined;
  // oxlint-disable-next-line promise/prefer-await-to-then promise/catch-or-return promise/always-return
  buildExit.then((result) => {
    buildExitResult = result;
  });

  while (true) {
    if (buildExitResult != null) {
      if (buildExitResult.error != null) {
        throw buildExitResult.error;
      }
      const exitCode =
        buildExitResult.code ?? signalExitCode(buildExitResult.signal);
      throw new Error(
        `Build watcher exited before startup completed: ${exitCode}`,
      );
    }

    // oxlint-disable-next-line no-await-in-loop
    const packages = await getTsdownPackages();
    // oxlint-disable-next-line no-await-in-loop
    const allGenerated = await Promise.all(
      packages.map(async (entry) => {
        const distDir = join(packagesDir, entry.name, "dist");
        // oxlint-disable-next-line no-sync
        if (!existsSync(distDir)) {
          return false;
        }
        const entries = await readdir(distDir);
        return entries.length > 0;
      }),
    );
    if (allGenerated.every(Boolean)) {
      return;
    }

    // oxlint-disable-next-line no-await-in-loop
    await sleep(100);
  }
}

async function shutdown(
  exitCode: number,
  signal: NodeJS.Signals,
  options: ShutdownOptions = {},
): Promise<void> {
  if (shuttingDown) {
    forceKill(serverProcess);
    forceKill(webProcess);
    forceKill(buildProcess);
    forceKill(mailpitProcess);
    process.exit(exitCode);
  }
  shuttingDown = true;

  await Promise.all([
    options.skipServer
      ? Promise.resolve()
      : terminate(serverProcess, signal === "SIGINT" ? "SIGINT" : "SIGTERM"),
    terminate(webProcess, "SIGTERM"),
    terminate(buildProcess, "SIGTERM"),
    terminate(mailpitProcess, "SIGTERM"),
  ]);
  process.exit(exitCode);
}

function waitForExit(child: ChildProcess): Promise<ExitResult> {
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ code: 1, error, signal: null }));
  });
}

function terminate(
  child: ChildProcess | undefined,
  signal: NodeJS.Signals,
): Promise<void> {
  if (child == null || child.exitCode != null || child.signalCode != null) {
    return Promise.resolve();
  }

  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      forceKill(child);
    }, 5000);

    child.once("exit", () => {
      clearTimeout(timeout);
      // oxlint-disable-next-line promise/no-multiple-resolved
      resolve();
    });
    killTree(child, signal);
  });
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (isWindows) {
      child.kill(signal);
    } else if (child.pid != null) {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (!isProcessLookupError(error)) {
      child.kill(signal);
    }
  }
}

function forceKill(child: ChildProcess | undefined): void {
  if (child == null || child.exitCode != null || child.signalCode != null) {
    return;
  }

  if (isWindows) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  try {
    if (child.pid != null) {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch (error) {
    if (!isProcessLookupError(error)) {
      child.kill("SIGKILL");
    }
  }
}

function isProcessLookupError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error != null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

function signalExitCode(signal: NodeJS.Signals | null): number | undefined {
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let buildProcess: ChildProcess | undefined;
let serverProcess: ChildProcess | undefined;
let webProcess: ChildProcess | undefined;
let mailpitProcess: ChildProcess | undefined;
let shuttingDown = false;

process.on("SIGINT", () => {
  void shutdown(0, "SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown(143, "SIGTERM");
});

try {
  const tsdownPackages = await getTsdownPackages();
  await removeDistDirs();

  buildProcess = spawnManaged(
    pnpm,
    [
      "--parallel",
      "--recursive",
      ...tsdownPackages.flatMap((entry) => [
        "--filter",
        `{./packages/${entry.name}}`,
      ]),
      "exec",
      "tsdown",
      "--watch",
      "--no-clean",
    ],
    root,
  );
  const buildExit = waitForExit(buildProcess);

  await waitForBuilds(buildExit);

  mailpitProcess = spawnManaged(
    "mailpit",
    ["--smtp", "localhost:1025", "--listen", "localhost:8025"],
    root,
  );

  const serverArgs: string[] = [
    "--watch",
    "bin/drfed-server.mjs",
    "--pglite-data-path",
    "../../.pgdata",
    "--listen=0.0.0.0:8888",
    "--smtp-url=smtp://localhost:1025",
    "--seed",
  ];

  const logLevel = process.env.usage_log_level;
  if (logLevel != null && logLevel !== "") {
    serverArgs.push("--log-level", logLevel);
  } else {
    serverArgs.push("--log-level", "debug");
  }

  const logOutput = process.env.usage_log_output;
  if (logOutput != null && logOutput !== "") {
    serverArgs.push("--log-output", logOutput);
  }

  serverProcess = spawnManaged(
    process.execPath,
    serverArgs,
    join(root, "packages", "drfed"),
  );
  webProcess = spawnManaged(
    pnpm,
    ["run", "dev"],
    join(root, "packages", "web"),
  );

  const serverExit = (async () => ({
    name: "server" as const,
    result: await waitForExit(serverProcess),
  }))();

  const webExit = (async () => ({
    name: "web" as const,
    result: await waitForExit(webProcess),
  }))();

  const mailpitExit = (async () => ({
    name: "mailpit" as const,
    result: await waitForExit(mailpitProcess),
  }))();

  const firstExit = await Promise.race([serverExit, webExit, mailpitExit]);

  if (firstExit.result.error != null) {
    throw firstExit.result.error;
  }
  const exitCode =
    firstExit.result.code ?? signalExitCode(firstExit.result.signal) ?? 1;
  await shutdown(exitCode, "SIGTERM", {
    skipServer: firstExit.name === "server",
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await shutdown(1, "SIGTERM");
}
