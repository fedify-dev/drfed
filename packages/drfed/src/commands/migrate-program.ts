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

import { object } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { map, optional, withDefault } from "@optique/core/modifiers";
import type { InferValue } from "@optique/core/parser";
import { flag, option } from "@optique/core/primitives";
import { integer, string, url } from "@optique/core/valueparser";
import { path } from "@optique/run/valueparser";

import {
  configurationProjection,
  configurationProvenance,
  createConfigurationBindings,
  configurationSettings as settings,
} from "../configuration.ts";
import { resolveDatabaseSettings } from "../database-settings.ts";
import { valueOptionNames } from "../parser.ts";

/**
 * Construct an independent database-only command using shared source bindings.
 * @returns Pure program metadata, contexts and the explicit TOML loader.
 */
export function createMigrationProgram(
  options: Parameters<typeof createConfigurationBindings>[0] = {},
) {
  const bindings = createConfigurationBindings(options);
  const { bind } = bindings;
  const lockTimeout = integer({
    min: 1,
    max: 2_147_483_647,
    metavar: "MILLISECONDS",
  });
  const parser = object({
    configPath: optional(
      bindings.bindConfigPath(
        option("--config", path({ metavar: "FILE", type: "file" }), {
          description: message`Read the shared DrFed TOML configuration file.`,
        }),
      ),
    ),
    dataPath: bind(
      option(
        ...valueOptionNames.dataPath,
        path({ metavar: "DIRECTORY", type: "directory" }),
        {
          description: message`Persistent PGlite directory; defaults to the OS data location.`,
        },
      ),
      settings.dataPath,
      string(),
      String,
    ),
    postgresUrl: bind(
      map(
        option(
          ...valueOptionNames.postgresUrl,
          url({ allowedProtocols: ["postgres:", "postgresql:"] }),
          {
            description: message`PostgreSQL connection URL.`,
          },
        ),
        (value) => value.href,
      ),
      settings.postgresUrl,
      string(),
      String,
    ),
    migrationLockTimeout: bind(
      option(...valueOptionNames.migrationLockTimeout, lockTimeout, {
        description: message`Maximum connection and migration lock wait in milliseconds.`,
      }),
      settings.migrationLockTimeout,
      lockTimeout,
      String,
      30_000,
    ),
    check: withDefault(
      flag("--check", {
        description: message`Inspect history without applying SQL or upgrading metadata. Exit 0 when ready, or 1 when preparation is needed or an error occurs.`,
      }),
      false,
    ),
    expandRevisions: withDefault(
      flag("--expand-revisions", {
        description: message`After applying migrations, record the JSON-LD expansion of every revision stored without one, loading remote contexts. Safe to run again.`,
      }),
      false,
    ),
    printConfig: withDefault(
      flag("--print-config", {
        description: message`Print effective settings and provenance with credentials redacted, then exit without opening runtime resources.`,
      }),
      false,
    ),
  });
  return {
    program: {
      metadata: {
        name: "drfed-migrate",
        description: message`Prepare the DrFed database or inspect migration history.`,
      },
      parser,
    },
    contexts: bindings.contexts,
    load: bindings.load,
  };
}

type RawMigrationOptions = InferValue<
  ReturnType<typeof createMigrationProgram>["program"]["parser"]
>;

/**
 * Select the winning database and retain source-only diagnostic metadata.
 * @returns Validated command settings without acquiring runtime resources.
 */
export function resolveMigrationOptions(
  raw: RawMigrationOptions,
  cwd = process.cwd(),
) {
  const selected = resolveDatabaseSettings(
    {
      dataPath: raw.dataPath,
      postgresUrl: raw.postgresUrl,
    },
    cwd,
  );
  const lockTimeoutMs = raw.migrationLockTimeout?.value;
  if (lockTimeoutMs === undefined) {
    throw new Error("Missing migration lock timeout.");
  }
  if (raw.check && raw.expandRevisions) {
    throw new Error("--check and --expand-revisions cannot be used together.");
  }
  return {
    database: { ...selected.database, lockTimeoutMs },
    check: raw.check,
    expandRevisions: raw.expandRevisions,
    printConfig: raw.printConfig,
    ignored: selected.ignored,
    provenance: configurationProvenance({
      dataPath: raw.dataPath,
      postgresUrl: raw.postgresUrl,
      migrationLockTimeout: raw.migrationLockTimeout,
    }),
  };
}

/**
 * Describe database-only settings and their sources without opening resources.
 * @returns Redacted settings and ignored configuration areas for diagnostics.
 */
export function describeMigrationConfiguration(
  options: ReturnType<typeof resolveMigrationOptions>,
) {
  const values = {
    databaseDriver: options.database.driver,
    dataPath:
      options.database.driver === "pglite"
        ? options.database.dataPath
        : undefined,
    postgresUrl:
      options.database.driver === "postgres" ? "<redacted>" : undefined,
    migrationLockTimeout: options.database.lockTimeoutMs,
  };
  const rank = { default: 0, config: 1, env: 2, cli: 3 };
  const selected = ["dataPath", "postgresUrl"]
    .map((key) => options.provenance[key])
    .filter((value) => value !== undefined)
    .sort((left, right) => rank[right.source] - rank[left.source])[0];
  return {
    command: "migrate" as const,
    mode: options.check
      ? "check"
      : options.expandRevisions
        ? "apply-and-expand"
        : "apply",
    settings: Object.fromEntries(
      Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [
          key === "databaseDriver"
            ? "database.driver"
            : settings[key as keyof typeof settings].toml,
          {
            value,
            ...((key === "databaseDriver"
              ? selected
              : options.provenance[key]) ?? { source: "default" as const }),
          },
        ]),
    ),
    ignored: [
      ...options.ignored,
      { field: "database.migrate", reason: "explicit apply/check mode" },
      ...configurationProjection("migrate").unusedAreas.map((area) => ({
        area,
        reason: "unused by this command",
      })),
    ],
  };
}
