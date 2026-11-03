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

// Create data with the previous release, then serve it with the candidate.
// oxlint-disable no-console no-await-in-loop max-statements
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { baseImage, readJson } from "../../layout.mts";
import {
  type Scenario,
  compose,
  composeFiles,
  createAccount,
  examples,
  exitCode,
  publishedPort,
} from "../harness.mts";
import { logIn, requestLogin } from "../login.mts";

interface UpgradeSource {
  readonly kind: "npm" | "image";
  readonly package?: string;
  readonly ref?: string;
}

export const checkUpgrade: Scenario = async (engine, context, image) => {
  const source = await readJson<UpgradeSource>(
    join(examples, "upgrade-source.json"),
  );
  const volume = `${context.prefix}-upgrade`;
  context.resources.volumes.add(volume);
  // Mounting the candidate first gives the empty volume its node ownership.
  await engine.succeed(["volume", "create", volume]);
  await engine.succeed([
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
  const old = `${context.prefix}-previous`;
  context.resources.containers.add(old);
  await engine.succeed([
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
    const result = await engine.run(["logs", name]);
    return result.stdout + result.stderr;
  };
  try {
    const deadline = Date.now() + 300_000;
    while (!/Listening on/u.test(await logs(old))) {
      assert.ok(Date.now() < deadline, await logs(old));
      await delay(1000);
    }
    const port = publishedPort(
      (await engine.succeed(["port", old, "8888"])).stdout,
    );
    await requestLogin(port, origin);
    await engine.succeed(["stop", "--time", "20", old]);
    assert.equal(await exitCode(engine, old), 0);
    const output = join(context.temporary, "account.json");
    await engine.succeed(["cp", `${old}:/tmp/account.json`, output]);
    const created = await readJson<{
      status: string;
      account: { id: string };
    }>(output);
    assert.equal(created.status, "created");
    const accountId = created.account.id;

    const override = join(context.temporary, "compose.upgrade.yaml");
    await writeFile(
      override,
      `volumes:\n  drfed-data:\n    name: ${volume}\n    external: true\n`,
    );
    const project = compose(
      engine,
      context,
      "upgrade",
      composeFiles("compose.pglite.yaml"),
      image,
    );
    project.env.COMPOSE_FILE += `${delimiter}${override}`;
    try {
      await project.up();
      await project.succeed(["stop", "drfed"]);
      await project.succeed([
        "run",
        "--rm",
        "drfed",
        "drfed-migrate",
        "--check",
      ]);
      const existing = await createAccount(project);
      assert.equal(existing.status, "exists");
      assert.equal(existing.account.id, accountId);
      await project.up();
      assert.ok(await logIn(project, await project.port(), origin));
      console.log(
        `Upgrade from ${source.package ?? source.ref} to the candidate passed (${engine.spec.label})`,
      );
    } catch (error) {
      console.error(await project.logs());
      throw error;
    }
  } catch (error) {
    console.error(await logs(old));
    throw error;
  }
};
