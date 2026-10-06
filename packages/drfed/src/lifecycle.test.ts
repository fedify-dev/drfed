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
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { type Server, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const binary = fileURLToPath(
  new URL("../bin/drfed-server.mjs", import.meta.resolve("@drfed/drfed")),
);
async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address != null && typeof address !== "string");
  return { server, port: address.port };
}
async function closeServer(server: Server) {
  const closed = once(server, "close");
  server.close();
  await closed;
}
function startServer(port: number, dataPath: string) {
  const child = spawn(
    process.execPath,
    [
      binary,
      "--root-origin=http://drfed.test",
      "--login-origin=http://drfed.test",
      `--listen=127.0.0.1:${port}`,
      `--pglite-data-path=${dataPath}`,
      "--log-level=error",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.resume();
  const exited = once(child, "close");
  return { child, exited, stderr: () => stderr };
}

async function waitForExit(run: ReturnType<typeof startServer>) {
  const stopTimeout = new AbortController();
  const timeout = async () => {
    await delay(90_000, undefined, { signal: stopTimeout.signal });
    assert.fail(`CLI did not exit within 90 seconds: ${run.stderr()}`);
  };
  try {
    return await Promise.race([run.exited, timeout()]);
  } finally {
    stopTimeout.abort();
  }
}

it("preserves a listen error when server startup fails", async () => {
  const { server, port } = await reservePort();
  const dataPath = await mkdtemp(join(tmpdir(), "drfed-startup-"));
  const run = startServer(port, dataPath);
  try {
    const [code] = await waitForExit(run);
    assert.equal(code, 1);
    assert.match(run.stderr(), /EADDRINUSE/u);
  } finally {
    run.child.kill("SIGKILL");
    await closeServer(server);
    await rm(dataPath, { recursive: true, force: true });
  }
});

it(
  "force-closes a stalled upload and exits normally on SIGTERM",
  {
    // Windows child.kill("SIGTERM") forcibly terminates without running handlers.
    skip: process.platform === "win32",
  },
  async () => {
    const { server, port } = await reservePort();
    await closeServer(server);
    const dataPath = await mkdtemp(join(tmpdir(), "drfed-shutdown-"));
    const run = startServer(port, dataPath);
    try {
      let ready = false;
      const readinessDeadline = performance.now() + 90_000;
      while (performance.now() < readinessDeadline) {
        assert.equal(run.child.exitCode, null, run.stderr());
        try {
          // oxlint-disable-next-line no-await-in-loop
          const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
            method: "POST",
            signal: AbortSignal.timeout(1000),
            headers: { "content-type": "application/json" },
            body: '{"query":"{ __typename }"}',
          });
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          // Migrations and listening have not finished yet.
        }
        // oxlint-disable-next-line no-await-in-loop
        await delay(100);
      }
      assert.ok(ready, run.stderr());
      const stalled = connect({ host: "127.0.0.1", port });
      // Force-closing a stalled upload may reset its socket.
      stalled.on("error", () => undefined);
      try {
        await once(stalled, "connect");
        stalled.write(
          "POST /graphql HTTP/1.1\r\nHost: drfed.test\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
        );
        await delay(100);
        run.child.kill("SIGTERM");
        const [code, signal] = await waitForExit(run);
        assert.equal(signal, null);
        assert.equal(code, 0, run.stderr());
      } finally {
        stalled.destroy();
      }
    } finally {
      run.child.kill("SIGKILL");
      await rm(dataPath, { recursive: true, force: true });
    }
  },
);
