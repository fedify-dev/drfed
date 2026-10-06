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

// A remote inbox served on a local port, for tests that run Fedify's own
// delivery against it.
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A response the inbox answers with: a status, a body, and a `Location`. */
export type InboxResponse = readonly [number, string, string?];

/** A request the inbox received. */
export interface InboxRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

/**
 * Serve an inbox answering each request, whatever its path, with the next
 * response, and keeping each request it received.
 * With no responses, the port is closed and every connection is refused.
 * @returns The result of the run.
 */
export async function withInbox<T>(
  responses: readonly InboxResponse[] | null,
  run: (inbox: URL, received: readonly InboxRequest[]) => Promise<T>,
): Promise<T> {
  const pending = [...(responses ?? [])];
  const received: InboxRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const [status, body, location] = pending.shift() ?? [500, "unexpected"];
      response.statusCode = status;
      if (location != null) response.setHeader("Location", location);
      response.end(body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const inbox = new URL(`http://127.0.0.1:${port}/inbox`);
  const close = async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  };
  if (responses == null) await close();
  try {
    return await run(inbox, received);
  } finally {
    if (responses != null) await close();
  }
}
