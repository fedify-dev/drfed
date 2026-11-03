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
import { once } from "node:events";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { requestInstalledWeb } from "./smoke-http.mts";

// Longer than the 10-second timeout of requestInstalledWeb().
const idle = 10_500;

test("A finished request's timeout leaves its pooled socket alone", async () => {
  const connections = new Set<number | undefined>();
  const server = createServer((incoming, response) => {
    if (incoming.url === "/slow") {
      setTimeout(() => response.end("slow"), idle);
    } else {
      response.end("fast");
    }
  });
  server.keepAliveTimeout = 60_000;
  server.on("connection", (socket) => connections.add(socket.remotePort));
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    assert.equal((await requestInstalledWeb(port, "/fast")).body, "fast");
    // A later request through the same global agent, with no timeout of its
    // own, stays idle on that socket past the first request's timeout.
    const result = Promise.withResolvers<string>();
    const later = request(
      { hostname: "127.0.0.1", port, path: "/slow" },
      (response) => {
        let output = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          output += chunk;
        });
        response.once("end", () => result.resolve(output));
        response.once("error", result.reject);
      },
    );
    later.once("error", result.reject);
    later.end();

    assert.equal(await result.promise, "slow");
    assert.equal(connections.size, 1, "the later request reused the socket");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
