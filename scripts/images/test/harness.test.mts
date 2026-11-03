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
import { test } from "node:test";

import { type Engine, resources } from "../engine.mts";
import { engineSpec } from "../engines.mts";
import { type Context, compose } from "./harness.mts";

const context: Context = {
  temporary: "/tmp/drfed-harness-test",
  prefix: "drfed-test",
  resources: resources(),
  metadata: {
    platform: "linux/amd64",
    created: "2026-01-01T00:00:00Z",
    base: { name: "node", digest: "sha256:test" },
    build: {
      enabled: true,
      version: "0.0.0",
      fullVersion: "0.0.0",
      baseVersion: "0.0.0",
      channel: "test",
      sha: "test",
      runNumber: "1",
      runId: "1",
      ref: "refs/heads/test",
      workflow: "test",
    },
    packages: [],
  },
};

test("Compose failures include the command, stdout and stderr", async () => {
  const result = {
    code: 1,
    stdout: "captured stdout",
    stderr: "captured stderr",
  };
  const engine: Engine = {
    spec: engineSpec("podman"),
    version: "5.7.0",
    platform: "linux/amd64",
    env: (extra = {}) => extra,
    run: () => Promise.resolve(result),
    succeed: () => Promise.resolve(result),
    compose: () => Promise.resolve(result),
  };
  const project = compose(engine, context, "failure", [], "drfed:test");

  await assert.rejects(project.succeed(["stop", "drfed"]), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /podman compose stop drfed/u);
    assert.match(error.message, /stdout:\ncaptured stdout/u);
    assert.match(error.message, /stderr:\ncaptured stderr/u);
    return true;
  });
});
