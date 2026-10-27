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

// Run the image layout that image:build wrote through the documented
// commands, Compose examples, backup and restore snippets, and an upgrade from
// the previous release, with one container engine.  Every container runs the
// exact layout bytes, whichever engine built them.
// oxlint-disable no-console
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import {
  type Engine,
  MissingEngine,
  cleanup,
  detect,
  load,
  resources,
} from "../engine.mts";
import { engineSpec } from "../engines.mts";
import {
  type ImageMetadata,
  architecture,
  metadataFile,
  readJson,
  root,
} from "../layout.mts";
import type { Context, Scenario } from "./harness.mts";
import { checkCommands } from "./scenarios/commands.mts";
import { checkPglite } from "./scenarios/pglite.mts";
import { checkPostgres } from "./scenarios/postgres.mts";
import { checkUpgrade } from "./scenarios/upgrade.mts";
import { checkSeparateWeb } from "./scenarios/web.mts";

const scenarios: readonly Scenario[] = [
  checkCommands,
  checkPglite,
  checkPostgres,
  checkSeparateWeb,
  checkUpgrade,
];

// The test:image:* tasks declare these with `usage`, so mise passes them as
// usage_* variables; direct runs pass them as arguments.
const { values } = parseArgs({
  options: {
    engine: { type: "string" },
    layout: { type: "string" },
    require: { type: "boolean" },
  },
});
const name = values.engine ?? process.env.usage_engine;
assert.ok(name, "Pass --engine with the container engine to test with");
const spec = engineSpec(name);
const required = values.require ?? process.env.usage_require === "true";

let engine: Engine;
try {
  engine = await detect(spec, { compose: true });
} catch (error) {
  if (!(error instanceof MissingEngine)) throw error;
  const message = `${error.message}; skipping the ${spec.label} image tests.`;
  if (required) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}

const layout = resolve(
  values.layout ??
    process.env.usage_layout ??
    join(root, "image-artifacts", `linux-${architecture(engine.platform)}`),
);
let metadata: ImageMetadata;
try {
  metadata = await readJson<ImageMetadata>(join(layout, metadataFile));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  console.error(
    `No image layout at ${layout}; build one with \`mise run image:build\`.`,
  );
  process.exit(1);
}
assert.equal(metadata.platform, engine.platform, "Foreign platform");
console.log(`Engine: ${spec.label} ${engine.version}`);
console.log(`Compose: ${engine.composeVersion}`);
console.log(`Layout: ${layout} (${metadata.platform})`);

const context: Context = {
  temporary: await mkdtemp(join(tmpdir(), "drfed-container-")),
  prefix: `drfed-ci-${process.pid}`,
  resources: resources(),
  metadata,
};
let passed = false;
try {
  // Registered first: the layout's index.json already names the image.
  context.resources.image = `localhost/${context.prefix}:candidate`;
  const image = await load(engine, layout, {
    tag: context.resources.image,
    temporary: context.temporary,
  });
  const platform = await engine.succeed([
    "image",
    "inspect",
    "--format",
    "{{.Os}}/{{.Architecture}}",
    image,
  ]);
  assert.equal(platform.stdout.trim(), metadata.platform);
  for (const scenario of scenarios) {
    // oxlint-disable-next-line no-await-in-loop
    await scenario(engine, context, image);
  }
  passed = true;
} finally {
  // Compose projects run from the temporary directory, so it goes last.
  const problems = await cleanup(engine, context.resources);
  await rm(context.temporary, { recursive: true, force: true });
  if (problems.length > 0) {
    console.error(`Cleanup failed:\n${problems.join("\n")}`);
    process.exitCode = 1;
  } else if (passed) {
    console.log(
      `All container checks passed for ${metadata.build.version} with ${spec.label}`,
    );
  }
}
