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
import process from "node:process";

import { createYogaServer } from "@drfed/graphql";
import { migrate } from "@drfed/models";
import { run } from "@optique/run";
import { serve } from "srvx";

import metadata from "../package.json" with { type: "json" };
import type { Options } from "./parser.ts";
import program from "./program.ts";

export async function main() {
  const options: Options = run(program, {
    help: "option",
    version: {
      value: metadata.version,
      option: true,
    },
    showChoices: true,
    showDefault: true,
  });
  if (options.drizzle.migrate) {
    await migrate({ credentials: options.drizzle.credentials });
  }
  const yogaServer = createYogaServer(options.drizzle.db);
  const server = serve({
    hostname: options.address.host,
    port: options.address.port,
    manual: true,
    fetch: yogaServer.fetch.bind(yogaServer),
  });
  const shutdown = () => {
    server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.serve();
}
