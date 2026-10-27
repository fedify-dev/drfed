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

// The PGlite Compose example: lock, shutdown, replacement, and the backup and
// restore snippets.
// oxlint-disable no-console no-await-in-loop
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { type Engine, type Result, exec } from "../../engine.mts";
import { forEngine } from "../../engines.mts";
import {
  type Context,
  type Project,
  type Scenario,
  compose,
  composeFiles,
  createAccount,
  examples,
  exitCode,
} from "../harness.mts";
import { expectPage, logIn } from "../login.mts";

/**
 * Run a documented snippet the way the engine's documentation page shows it;
 * the page of the engine the file is written for shows it unchanged.
 * @returns How the snippet exited.
 */
async function runSnippet(
  engine: Engine,
  file: string,
  directory: string,
  env: NodeJS.ProcessEnv,
  { expectSuccess = true, readOnly = false } = {},
): Promise<Result> {
  const script = join(directory, `${engine.spec.name}-${file}`);
  await writeFile(
    script,
    forEngine(await readFile(join(examples, file), "utf8"), engine.spec.name),
  );
  if (readOnly) await chmod(directory, 0o555);
  try {
    const result = await exec("sh", [script], { cwd: directory, env });
    if (expectSuccess) {
      assert.equal(result.code, 0, `${file}\n${result.stdout}${result.stderr}`);
    }
    return result;
  } finally {
    if (readOnly) await chmod(directory, 0o755);
  }
}

/**
 * A backup that cannot write keeps the previous backup and starts the server
 * it stopped again.
 */
async function checkFailedBackup(
  engine: Engine,
  context: Context,
  project: Project,
): Promise<void> {
  // Root writes to a read-only directory, so the backup would not fail.
  if (process.getuid?.() === 0) return;
  const directory = await mkdtemp(join(context.temporary, "failed-backup-"));
  const previous = join(directory, "drfed-data.tgz");
  await writeFile(previous, "previous backup");
  const before = await project.listening();
  const failed = await runSnippet(engine, "backup.sh", directory, project.env, {
    expectSuccess: false,
    readOnly: true,
  });
  assert.notEqual(failed.code, 0, "The backup cannot write its file.");
  assert.equal(await readFile(previous, "utf8"), "previous backup");
  await project.waitListening(before);
}

async function checkBackup(
  engine: Engine,
  context: Context,
  project: Project,
  image: string,
  accountId: string,
  origin: string,
): Promise<void> {
  // The documented case: back up while the server runs.
  await project.up();
  await checkFailedBackup(engine, context, project);
  const directory = await mkdtemp(join(context.temporary, "backup-"));
  const before = await project.listening();
  await runSnippet(engine, "backup.sh", directory, project.env);
  await project.waitListening(before);
  const restored = compose(
    engine,
    context,
    "restore",
    composeFiles("compose.pglite.yaml"),
    image,
  );
  try {
    await runSnippet(engine, "restore.sh", directory, restored.env);
    await restored.waitListening(0);
    assert.ok(await logIn(restored, await restored.port(), origin));
    assert.equal((await restored.call(["stop", "drfed"])).code, 0);
    // A stopped server stays stopped, which the PGlite lock below relies on.
    const stopped = await mkdtemp(join(context.temporary, "stopped-backup-"));
    await runSnippet(engine, "backup.sh", stopped, restored.env);
    assert.ok((await stat(join(stopped, "drfed-data.tgz"))).size > 0);
    const running = await restored.call([
      "ps",
      "--status",
      "running",
      "--quiet",
      "drfed",
    ]);
    assert.equal(running.code, 0, running.stderr);
    assert.equal(running.stdout.trim(), "");
    const existing = await createAccount(restored);
    assert.equal(existing.status, "exists");
    assert.equal(existing.account.id, accountId);
    console.log(`Backup and restore snippets passed (${engine.spec.label})`);
  } catch (error) {
    console.error(await restored.logs());
    throw error;
  }
}

export const checkPglite: Scenario = async (engine, context, image) => {
  const origin = "http://drfed.localhost:8888";
  const project = compose(
    engine,
    context,
    "pglite",
    composeFiles("compose.pglite.yaml"),
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
    assert.equal(await exitCode(engine, first), 0);
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
    console.log(
      `PGlite example, lock, shutdown and replacement passed (${engine.spec.label})`,
    );

    await checkBackup(
      engine,
      context,
      project,
      image,
      created.account.id,
      origin,
    );
  } catch (error) {
    console.error(await project.logs());
    throw error;
  }
};
