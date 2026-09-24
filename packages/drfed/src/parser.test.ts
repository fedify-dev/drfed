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
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, it } from "@logtape/testing-node/autoload";

const execFileAsync = promisify(execFile);

const commandTimeout = 30_000;

// The binary rather than the parser module, because what matters here is the
// contract the installed command exposes.  Parsing `--pglite-data-path` opens
// a database as a side effect, so every case below either fails during parsing
// or takes the schema-generation branch, which needs no database at all.  That
// is also why none of them need `DRFED_LOGIN_ORIGINS`: the server never gets
// far enough to read it.
const binary = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "drfed-server.mjs",
);

async function run(
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [binary, ...args],
      {
        // A deliberately minimal environment.  Leaving `DRFED_LOGIN_ORIGINS`
        // out means that a command line which parses successfully still stops
        // immediately instead of starting a server, whatever the developer
        // happens to have exported.
        env: { PATH: process.env.PATH ?? "" },
        timeout: commandTimeout,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (e) {
    const error = e as { code?: number; stdout?: string; stderr?: string };
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

describe("drfed-server", () => {
  it("requires --root-origin to serve", async () => {
    const { code, stderr } = await run(["--data-path", "/nonexistent-drfed"]);

    assert.notEqual(code, 0);
    assert.match(stderr, /Missing option .*--root-origin/u);
  });

  it("advertises --root-origin as required in its help", async () => {
    const { code, stdout } = await run(["--help"]);
    assert.equal(code, 0);
    // Optional options are bracketed in the usage line; this one must not be.
    assert.match(stdout, /--root-origin\/-r ORIGIN/u);
    assert.doesNotMatch(stdout, /\[--root-origin/u);
  });

  it("no longer accepts the old --root-domain option", async () => {
    // Everything else on this command line is valid, so the only thing that
    // can go wrong is the retired option.  If it were reinstated, parsing
    // would succeed and the run would instead stop on the missing
    // `DRFED_LOGIN_ORIGINS`, which says something else entirely.
    const dataPath = await mkdtemp(join(tmpdir(), "drfed-parser-test-"));
    try {
      const { code, stderr } = await run([
        "--data-path",
        dataPath,
        "--root-origin=https://drfed.net",
        "--root-domain=drfed.net",
      ]);
      assert.notEqual(code, 0);
      // The message names the offending token, so this cannot pass for some
      // other reason.
      assert.match(stderr, /Unexpected option or argument: "--root-domain/u);
    } finally {
      await rm(dataPath, { force: true, recursive: true });
    }
  });

  it("rejects a root origin that names an IP address", async () => {
    const { code, stderr } = await run([
      "--data-path",
      "/nonexistent-drfed",
      "--root-origin=http://127.0.0.1:8888",
    ]);
    assert.notEqual(code, 0);
    assert.match(stderr, /IP address/u);
  });

  it("accepts --email-from and rejects a malformed address", async () => {
    const dataPath = await mkdtemp(join(tmpdir(), "drfed-parser-test-"));
    try {
      // Valid: parsing gets past the option and stops only on the missing
      // login origins, which is the next thing the server reads.
      const accepted = await run([
        "--data-path",
        dataPath,
        "--root-origin=https://drfed.net",
        "--email-from=postmaster@mail.example",
      ]);
      assert.notEqual(accepted.code, 0);
      assert.match(accepted.stderr, /Missing option .*--login-origin/u);

      const rejected = await run([
        "--data-path",
        dataPath,
        "--root-origin=https://drfed.net",
        "--login-origin=https://drfed.net",
        "--email-from=not-an-address",
      ]);
      assert.notEqual(rejected.code, 0);
      assert.match(rejected.stderr, /Expected a valid email address/u);
    } finally {
      await rm(dataPath, { force: true, recursive: true });
    }
  });

  it("generates the GraphQL schema without a root origin", async () => {
    // Schema generation is the other branch of the parser and must stay
    // usable without any deployment configuration; `mise run build` calls it.
    const { code, stdout } = await run([
      "--generate-graphql-schema",
      "--output-file",
      "-",
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /type Query/u);
  });
});
