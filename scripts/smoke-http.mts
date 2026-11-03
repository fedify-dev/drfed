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

// HTTP requests with an explicit Host header, which fetch() cannot send.
// Shared by the npm packaging and container image tests.
import { type IncomingHttpHeaders, request as httpRequest } from "node:http";

export interface WebSmokeResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
export async function requestInstalledWeb(
  port: number,
  path: string,
  headers: Readonly<Record<string, string>> = {},
  body?: string,
): Promise<WebSmokeResponse> {
  const result = Promise.withResolvers<WebSmokeResponse>();
  const request = httpRequest(
    {
      hostname: "127.0.0.1",
      port,
      path,
      method: body === undefined ? "GET" : "POST",
      headers: { host: "drfed.test", ...headers },
    },
    (response) => {
      let output = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        output += chunk;
      });
      response.once("end", () =>
        result.resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: output,
        }),
      );
      response.once("error", result.reject);
    },
  );
  request.once("error", result.reject);
  request.setTimeout(10_000, () =>
    request.destroy(new Error("Installed web request timed out.")),
  );
  request.end(body);
  return await result.promise;
}
