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
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";

import metadata from "./package.json" with { type: "json" };
import { verifyMigrationManifest } from "./src/migration-manifest.ts";

export default defineConfig({
  ...metadata.tsdown,
  copy: [fileURLToPath(new URL("./migrations-manifest.json", import.meta.url))],
  hooks: {
    "build:prepare": async () => {
      await verifyMigrationManifest({
        manifestPath: fileURLToPath(
          new URL("./migrations-manifest.json", import.meta.url),
        ),
        migrationsFolder: fileURLToPath(new URL("./drizzle/", import.meta.url)),
      });
    },
  },
});
