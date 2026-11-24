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

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import {
  createMigrationProgram,
  describeMigrationConfiguration,
  resolveMigrationOptions,
} from "@drfed/drfed/commands/migrate-program";
import { run } from "@optique/run";

async function parse(args: string[], env: Record<string, string>, cwd: string) {
  const invocation = createMigrationProgram({ env: (name) => env[name], cwd });
  const raw = await run(invocation.program, {
    args,
    contexts: invocation.contexts,
    contextOptions: { load: invocation.load },
    colors: false,
    stderr: () => undefined,
    onExit(code): never {
      throw new Error(`CLI exit ${code}`);
    },
  });
  return resolveMigrationOptions(raw, cwd);
}

it("preserves path characters and CLI/env/TOML precedence with native path parsers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-path-precedence-"));
  const filename = "config with spaces;[draft]$cash.toml";
  const configuredPath = "configured data/[draft]$cash";
  try {
    await writeFile(
      join(directory, filename),
      `[database]\ndata_path = "${configuredPath}"\n`,
    );
    const configured = await parse(["--config", filename], {}, directory);
    assert.equal(configured.database.driver, "pglite");
    if (configured.database.driver !== "pglite") throw new Error();
    assert.equal(configured.database.dataPath, join(directory, configuredPath));
    const environment = { DRFED_DATA_PATH: "environment data/[draft]$cash" };
    const overridden = await parse(
      ["--config", filename],
      environment,
      directory,
    );
    if (overridden.database.driver !== "pglite") throw new Error();
    assert.equal(
      overridden.database.dataPath,
      join(directory, environment.DRFED_DATA_PATH),
    );
    const cliPath = "CLI data/[draft]$cash";
    const cli = await parse(
      ["--config", filename, "-d", cliPath],
      environment,
      directory,
    );
    if (cli.database.driver !== "pglite") throw new Error();
    assert.equal(cli.database.dataPath, join(directory, cliPath));
    assert.equal(
      describeMigrationConfiguration(cli).settings["database.data_path"]
        ?.source,
      "cli",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("shares TOML/env/CLI database precedence while ignoring server and mail domains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-migrate-parser-"));
  try {
    await writeFile(
      join(directory, "drfed.toml"),
      '[server]\nroot_origin="http://127.0.0.1"\n[database]\ndata_path="./data"\nlock_timeout_ms=123\nmigrate=false\n[mail.smtp]\nurl="not a URL"\n',
    );
    const env = {
      DRFED_ROOT_ORIGIN: "not an origin",
      DRFED_LOGIN_ORIGINS: "invalid JSON",
      DRFED_SMTP_URL: "invalid URL",
      DRFED_LOG_LEVEL: "invalid",
      DRFED_MIGRATE: "invalid ignored boolean",
    };
    const configured = await parse(["--config", "drfed.toml"], env, directory);
    assert.equal(configured.check, false);
    assert.deepEqual(configured.database, {
      driver: "pglite",
      dataPath: join(directory, "data"),
      lockTimeoutMs: 123,
    });
    const overridden = await parse(
      ["--config", "drfed.toml", "--migration-lock-timeout=789", "--check"],
      { ...env, DRFED_MIGRATION_LOCK_TIMEOUT: "456" },
      directory,
    );
    assert.equal(overridden.database.lockTimeoutMs, 789);
    assert.equal(overridden.check, true);
    const diagnostic = describeMigrationConfiguration(overridden);
    assert.equal(
      diagnostic.settings["database.lock_timeout_ms"]?.source,
      "cli",
    );
    assert.equal(
      diagnostic.settings["database.data_path"]?.configPath,
      join(directory, "drfed.toml"),
    );
    assert.equal(
      diagnostic.settings["database.data_path"]?.value,
      join(directory, "data"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("redacts a selected PostgreSQL URL and validates only the active database", async () => {
  const options = await parse(
    [
      "--postgres-url=postgres://user:PRIVATE_PASSWORD@localhost/drfed",
      "--print-config",
    ],
    { DRFED_DATA_PATH: "" },
    process.cwd(),
  );
  assert.equal(options.database.driver, "postgres");
  assert.equal(options.printConfig, true);
  assert.doesNotMatch(
    JSON.stringify(describeMigrationConfiguration(options)),
    /PRIVATE_PASSWORD/u,
  );
  assert.equal(
    describeMigrationConfiguration(options).settings["database.url"]?.value,
    "<redacted>",
  );
});

it("rejects invalid active settings and does not accept --no-migrate", async () => {
  await assert.rejects(
    parse([], { DRFED_MIGRATION_LOCK_TIMEOUT: "bad" }, process.cwd()),
    /CLI exit 1/u,
  );
  await assert.rejects(
    parse(["--no-migrate"], {}, process.cwd()),
    /CLI exit 1/u,
  );
});

it("uses mutually exclusive typed database selectors and rejects the removed driver flag", async () => {
  const cwd = process.cwd();
  await assert.rejects(
    parse(["--database-driver=postgres"], {}, cwd),
    /CLI exit 1/u,
  );
  await assert.rejects(
    parse(
      ["--pglite-data-path=data", "--postgres-url=postgres://db/drfed"],
      {},
      cwd,
    ),
    /mutually exclusive/u,
  );
  await assert.rejects(
    parse(["--pglite-data-path=   "], {}, cwd),
    /CLI exit 1/u,
  );
  await assert.rejects(
    parse(["--postgres-url=https://user:PRIVATE_TOKEN@db/drfed"], {}, cwd),
    /CLI exit 1/u,
  );
  const selected = await parse(
    ["--postgres-url=POSTGRESQL://user@db/drfed"],
    { DRFED_DATA_PATH: "lower-data" },
    cwd,
  );
  assert.equal(selected.database.driver, "postgres");
});

it("expands revisions only when applying migrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-migrate-expand-"));
  try {
    const plain = await parse(["-d", "data"], {}, directory);
    assert.equal(plain.expandRevisions, false);
    assert.equal(describeMigrationConfiguration(plain).mode, "apply");
    const expand = await parse(
      ["-d", "data", "--expand-revisions"],
      {},
      directory,
    );
    assert.equal(expand.expandRevisions, true);
    assert.equal(
      describeMigrationConfiguration(expand).mode,
      "apply-and-expand",
    );
    await assert.rejects(
      parse(["-d", "data", "--check", "--expand-revisions"], {}, directory),
      /--check and --expand-revisions cannot be used together\./u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
