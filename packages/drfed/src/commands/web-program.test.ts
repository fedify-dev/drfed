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
  createWebProgram,
  describeWebConfiguration,
  resolveWebOptions,
} from "@drfed/drfed/commands/web-program";
import { run } from "@optique/run";

async function parse(args: string[], env: Record<string, string>, cwd: string) {
  const invocation = createWebProgram({ env: (name) => env[name], cwd });
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
  return resolveWebOptions(raw, cwd);
}

it("uses the shared web namespace and ignores backend database/mail domains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-web-parser-"));
  try {
    await writeFile(
      join(directory, "drfed.toml"),
      '[server]\nroot_origin="invalid"\nlisten="invalid"\n[web]\npublic_origin="https://APP.EXAMPLE:443/"\nbackend_url="https://backend.example:8888"\nlisten="localhost:3001"\n[database]\nurl="PRIVATE_TOKEN"\n[mail.smtp]\nurl="invalid"\n[telemetry]\nlog_output="web.log"\nlog_level="debug"\n',
    );
    const configured = await parse(
      ["--config", "drfed.toml"],
      {
        DRFED_ROOT_ORIGIN: "invalid",
        DRFED_POSTGRES_URL: "PRIVATE_SECRET",
        DRFED_SMTP_URL: "invalid",
        DRFED_LISTEN: "invalid",
      },
      directory,
    );
    assert.equal(configured.publicOrigin.origin, "https://app.example");
    assert.equal(configured.backendUrl.origin, "https://backend.example:8888");
    assert.deepEqual(configured.address, { host: "localhost", port: 3001 });
    assert.equal(configured.logging.logOutput.type, "file");
    if (configured.logging.logOutput.type === "file") {
      assert.equal(
        configured.logging.logOutput.path,
        join(directory, "web.log"),
      );
    }
    const diagnostic = describeWebConfiguration(configured);
    assert.equal(diagnostic.settings["web.public_origin"]?.source, "config");
    assert.ok(diagnostic.ignored.some((entry) => entry.area === "database"));
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE/u);
    const overridden = await parse(
      [
        "--config",
        "drfed.toml",
        "--public-origin=http://cli.example",
        "--listen=127.0.0.1:3003",
      ],
      {
        DRFED_PUBLIC_ORIGIN: "https://env.example",
        DRFED_WEB_LISTEN: "localhost:3002",
        DRFED_BACKEND_URL: "https://backend-env.example",
      },
      directory,
    );
    assert.equal(overridden.publicOrigin.origin, "http://cli.example");
    assert.equal(overridden.backendUrl.origin, "https://backend-env.example");
    assert.equal(overridden.address.port, 3003);
    assert.equal(overridden.provenance.publicOrigin?.source, "cli");
    assert.equal(overridden.provenance.backendUrl?.source, "env");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("requires only HTTP origins and validates the active logging projection", async () => {
  await assert.rejects(parse([], {}, process.cwd()), /public-origin/u);
  await assert.rejects(
    parse(["--public-origin=http://app.example"], {}, process.cwd()),
    /backend-url/u,
  );
  await assert.rejects(
    parse(
      [
        "--public-origin=ftp://app.example",
        "--backend-url=https://backend.example",
      ],
      {},
      process.cwd(),
    ),
  );
  const normalized = await parse(
    [
      "--public-origin=http://app.example/page",
      "--backend-url=https://backend.example/graphql",
    ],
    {},
    process.cwd(),
  );
  assert.equal(normalized.publicOrigin.origin, "http://app.example");
  assert.equal(normalized.backendUrl.origin, "https://backend.example");
  await assert.rejects(
    parse(
      [
        "--public-origin=http://app.example",
        "--backend-url=http://user:pass@backend.example",
      ],
      {},
      process.cwd(),
    ),
  );
  await assert.rejects(
    parse(
      [
        "--public-origin=http://app.example",
        "--backend-url=https://backend.example",
        "--log-output=   ",
      ],
      {},
      process.cwd(),
    ),
    /empty/u,
  );
  const resolved = await parse(
    [
      "--public-origin=http://app.example",
      "--backend-url=https://backend.example",
    ],
    {},
    process.cwd(),
  );
  assert.deepEqual(resolved.address, { host: "localhost", port: 3000 });
  assert.equal(resolved.logging.logLevel, "info");
});

it("listens on every interface by default inside the container image", async () => {
  const args = [
    "--public-origin=http://app.example",
    "--backend-url=https://backend.example",
  ];
  const marked = await parse(args, { DRFED_CONTAINER: "1" }, process.cwd());
  assert.deepEqual(marked.address, { host: "0.0.0.0", port: 3000 });
  assert.equal(
    describeWebConfiguration(marked).settings["web.listen"]?.source,
    "default",
  );
  const overridden = await parse(
    args,
    { DRFED_CONTAINER: "1", DRFED_WEB_LISTEN: "localhost:3001" },
    process.cwd(),
  );
  assert.deepEqual(overridden.address, { host: "localhost", port: 3001 });
});

it("requires HTTPS outside loopback unless explicitly allowed", async () => {
  const args = ["--public-origin=https://app.example"];
  await Promise.all(
    ["localhost", "dev.localhost", "127.0.0.1", "127.255.2.3", "[::1]"].map(
      async (backend) => {
        const result = await parse(
          [...args, `--backend-url=http://${backend}:8888`],
          {},
          process.cwd(),
        );
        assert.equal(result.insecureBackend, false);
      },
    ),
  );
  await Promise.all(
    [
      "backend.example",
      "127.evil.example",
      "localhost.example",
      "192.168.1.1",
      "[::2]",
    ].map(async (backend) => {
      const options = [...args, `--backend-url=http://${backend}`];
      await assert.rejects(
        parse(options, {}, process.cwd()),
        /requires HTTPS/u,
      );
      const allowed = await parse(
        [...options, "--allow-insecure-backend"],
        {},
        process.cwd(),
      );
      assert.equal(allowed.allowInsecureBackend, true);
      assert.equal(allowed.insecureBackend, true);
      assert.equal(
        describeWebConfiguration(allowed).settings["web.allow_insecure_backend"]
          ?.source,
        "cli",
      );
    }),
  );
});

it("uses shared HTTP permission precedence and supports explicitly revoking it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-web-http-policy-"));
  try {
    await writeFile(
      join(directory, "drfed.toml"),
      '[web]\npublic_origin="https://app.example"\nbackend_url="http://backend.internal"\nallow_insecure_backend=true\n',
    );
    const args = ["--config", "drfed.toml"];
    const configured = await parse(args, {}, directory);
    assert.equal(configured.allowInsecureBackend, true);
    assert.equal(configured.provenance.allowInsecureBackend?.source, "config");
    await assert.rejects(
      parse(args, { DRFED_ALLOW_INSECURE_BACKEND: "false" }, directory),
      /requires HTTPS/u,
    );
    const env = { DRFED_ALLOW_INSECURE_BACKEND: "true" };
    const fromEnv = await parse(args, env, directory);
    assert.equal(fromEnv.provenance.allowInsecureBackend?.source, "env");
    await assert.rejects(
      parse([...args, "--no-allow-insecure-backend"], env, directory),
      /requires HTTPS/u,
    );
    const fromCli = await parse(
      [...args, "--allow-insecure-backend"],
      { DRFED_ALLOW_INSECURE_BACKEND: "false" },
      directory,
    );
    assert.equal(fromCli.provenance.allowInsecureBackend?.source, "cli");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
