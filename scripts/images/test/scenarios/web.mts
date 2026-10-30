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

// The separate frontend Compose example.
// oxlint-disable no-console
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { requestInstalledWeb } from "../../../smoke-http.mts";
import {
  type Scenario,
  compose,
  composeFiles,
  examples,
  exitCode,
} from "../harness.mts";
import { expectPage } from "../login.mts";

export const checkSeparateWeb: Scenario = async (engine, context, image) => {
  const override = join(context.temporary, "compose.web.ci.yaml");
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
    engine,
    context,
    "web",
    [
      join(examples, "compose.pglite.yaml"),
      join(examples, "compose.web.yaml"),
      ...composeFiles(),
      override,
    ],
    image,
  );
  try {
    await project.succeed(["up", "--detach"]);
    await project.waitListening(0);
    await project.waitListening(0, "web");
    const backend = await requestInstalledWeb(await project.port(), "/about", {
      host: "drfed.localhost:8888",
    });
    assert.equal(backend.status, 404);
    await expectPage(await project.port("web", 3000), "localhost:3000");
    const container = await project.container("web");
    await project.succeed(["stop"]);
    assert.equal(await exitCode(engine, container), 0);
    console.log(`Separate frontend example passed (${engine.spec.label})`);
  } catch (error) {
    console.error(await project.logs());
    console.error(await project.logs("web"));
    throw error;
  }
};
