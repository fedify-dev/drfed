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

// The four commands, the entrypoint, labels, user and volume ownership.
// oxlint-disable no-console no-await-in-loop
import assert from "node:assert/strict";

import { imageAnnotations } from "../../layout.mts";
import type { Scenario } from "../harness.mts";

export const checkCommands: Scenario = async (engine, context, image) => {
  const { metadata } = context;
  const labels = await engine.succeed([
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
    const version = await engine.succeed([
      "run",
      "--rm",
      image,
      command,
      "--version",
    ]);
    assert.ok(version.stdout.includes(metadata.build.version), version.stdout);
  }
  const help = async (args: readonly string[]) =>
    (await engine.succeed(["run", "--rm", image, ...args])).stdout;
  assert.match(await help(["drfed-migrate", "--help"]), /--check/u);
  assert.match(await help(["drfed-web", "--help"]), /--backend-url/u);
  assert.match(await help(["drfed-account", "--help"]), /create/u);
  // Leading options go to drfed-server; no arguments run drfed-server.
  assert.match(await help(["--help"]), /--root-origin/u);
  const missing = await engine.run(["run", "--rm", image]);
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

  const volume = `${context.prefix}-ownership`;
  context.resources.volumes.add(volume);
  await engine.succeed(["volume", "create", volume]);
  const mount = `${volume}:/var/lib/drfed`;
  const check = await engine.run([
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
  const owner = await engine.succeed([
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
  console.log(
    `Commands, entrypoint, labels, user and volume ownership passed (${engine.spec.label})`,
  );
};
