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

// The PostgreSQL Compose example.
// oxlint-disable no-console
import assert from "node:assert/strict";

import {
  type Scenario,
  compose,
  composeFiles,
  createAccount,
  exitCode,
} from "../harness.mts";
import { requestLogin } from "../login.mts";

export const checkPostgres: Scenario = async (engine, context, image) => {
  const project = compose(
    engine,
    context,
    "postgres",
    composeFiles("compose.postgres.yaml"),
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
    assert.equal(await exitCode(engine, container), 0);
    assert.equal(
      (await project.call(["run", "--rm", "drfed", "drfed-migrate", "--check"]))
        .code,
      0,
    );
    console.log(`PostgreSQL example passed (${engine.spec.label})`);
  } catch (error) {
    console.error(await project.logs());
    console.error(await project.logs("postgres"));
    throw error;
  }
};
