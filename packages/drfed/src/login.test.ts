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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const requestTimeout = 5_000;
const binary = fileURLToPath(
  new URL("../bin/drfed-server.mjs", import.meta.url),
);

// oxlint-disable-next-line max-statements
it("normalizes CLI login origins and preserves the allowlist", async () => {
  // The CLI requires a nonzero port; obtain an available one from the OS.
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address != null && typeof address !== "string");
  await socket[Symbol.asyncDispose]();

  const dataPath = await mkdtemp(join(tmpdir(), "drfed-login-test-"));
  const child = spawn(
    process.execPath,
    [
      binary,
      "--data-path",
      dataPath,
      `--listen=127.0.0.1:${address.port}`,
      "--root-origin=https://drfed.example",
      "--login-origin=https://app.example.",
      "--login-origin=http://127.0.0.1:3000",
      "--login-origin=http://[::1]:3000",
    ],
    {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.includes("Listening on:")) ready.resolve();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.once("error", ready.reject);
  child.once("close", (code, signal) => {
    ready.reject(
      new Error(
        `CLI exited before listening (${code}, ${signal})\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`,
      ),
    );
    closed.resolve();
  });

  try {
    await ready.promise;
    const endpoint = `http://127.0.0.1:${address.port}/graphql`;
    await Promise.all(
      [
        "https://app.example",
        "http://127.0.0.1:3000",
        "http://[::1]:3000",
        "https://untrusted.example",
      ].map(async (origin) => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(requestTimeout),
          body: JSON.stringify({
            query: `
            mutation Login($email: Email!, $verifyUrl: URITemplate!) {
              loginByEmail(email: $email, verifyUrl: $verifyUrl) {
                challengeId
              }
            }
          `,
            variables: {
              email: "unknown@example.com",
              verifyUrl: `${origin}/verify?challengeId={challengeId}&code={code}`,
            },
          }),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        if (origin === "https://untrusted.example") {
          assert.equal(body.data, null);
          assert.equal(
            body.errors[0].message,
            `Verify URL origin is not allowed: ${origin}.`,
          );
        } else {
          assert.equal(
            body.errors,
            undefined,
            `${origin}: ${JSON.stringify(body)}`,
          );
          assert.ok(body.data.loginByEmail.challengeId);
        }
      }),
    );
  } finally {
    child.kill("SIGTERM");
    await closed.promise;
    await rm(dataPath, { force: true, recursive: true });
  }
});
