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

// `mise run image:build`: build one platform image from the package tarballs
// into an OCI layout with Docker or Podman.  The layout and its metadata have
// the same form whichever engine built them.
// oxlint-disable no-console no-await-in-loop
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { type Engine, detect, exec, firstUsable } from "./engine.mts";
import { engineSpec } from "./engines.mts";
import {
  type Build,
  type Bundle,
  type ImageMetadata,
  type PackageArtifact,
  architecture,
  baseImage,
  metadataFile,
  packageOrder,
  readJson,
  root,
  singleImage,
} from "./layout.mts";

const execute = promisify(execFile);

async function run(
  binary: string,
  args: readonly string[],
  options: { readonly cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return await execute(binary, args, {
    cwd: options.cwd ?? root,
    timeout: 1_800_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Pack the workspace like release:pack, for pull requests and local use. */
async function packWorkspace(directory: string): Promise<void> {
  const build = JSON.parse(
    (
      await run(process.execPath, [
        join(root, "scripts", "release.mts"),
        "version",
      ])
    ).stdout,
  ) as Build;
  const packages: PackageArtifact[] = [];
  for (const name of packageOrder) {
    const { stdout } = await run(
      "pnpm",
      ["pack", "--json", "--pack-destination", directory],
      { cwd: join(root, "packages", name) },
    );
    const filename = basename(
      (JSON.parse(stdout) as { filename: string }).filename,
    );
    const bytes = await readFile(join(directory, filename));
    packages.push({
      name: `@drfed/${name}`,
      filename,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    });
  }
  const bundle: Bundle = { build, packages };
  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify(bundle, null, 2)}\n`,
  );
}

async function checkBundle(directory: string): Promise<Bundle> {
  const bundle = await readJson<Bundle>(join(directory, "manifest.json"));
  assert.deepEqual(
    bundle.packages.map(({ name }) => name),
    packageOrder.map((name) => `@drfed/${name}`),
  );
  for (const [index, entry] of bundle.packages.entries()) {
    assert.equal(
      entry.filename,
      `drfed-${packageOrder[index]}-${bundle.build.version}.tgz`,
    );
    const bytes = await readFile(join(directory, entry.filename));
    assert.equal(
      entry.integrity,
      `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      `Tarball integrity mismatch: ${entry.filename}`,
    );
  }
  return bundle;
}

/**
 * The commit time, so that rebuilding a commit keeps its timestamps.
 * @returns Seconds since the epoch.
 */
async function commitEpoch(sha: string): Promise<string> {
  const { stdout } = await run("git", ["show", "-s", "--format=%ct", sha]);
  assert.match(stdout.trim(), /^\d+$/u);
  return stdout.trim();
}

/**
 * Build one platform image from a tarball directory into an OCI layout.
 * @returns The written layout's metadata.
 */
export async function buildImage(options: {
  readonly engine?: string | undefined;
  readonly artifacts?: string | undefined;
  readonly platform?: string | undefined;
  readonly output?: string | undefined;
}): Promise<ImageMetadata> {
  const engine: Engine =
    options.engine === undefined
      ? await firstUsable()
      : await detect(engineSpec(options.engine));
  console.log(`Building with ${engine.spec.label} ${engine.version}`);
  const platform = options.platform ?? engine.platform;
  const arch = architecture(platform);
  const output = resolve(
    options.output ?? join(root, "image-artifacts", `linux-${arch}`),
  );
  const temporary = await mkdtemp(join(tmpdir(), "drfed-image-"));
  try {
    // A fresh context holds exactly what the Containerfile copies, so the
    // build needs no named contexts or bind mounts.
    const context = join(temporary, "context");
    await mkdir(context);
    if (options.artifacts) {
      const bundle = await readJson<Bundle>(
        join(resolve(options.artifacts), "manifest.json"),
      );
      await Promise.all(
        [
          "manifest.json",
          ...bundle.packages.map(({ filename }) => basename(filename)),
        ].map((file) =>
          copyFile(
            join(resolve(options.artifacts!), file),
            join(context, file),
          ),
        ),
      );
    } else {
      await packWorkspace(context);
    }
    await copyFile(
      join(root, "docker", "docker-entrypoint.sh"),
      join(context, "docker-entrypoint.sh"),
    );
    await chmod(join(context, "docker-entrypoint.sh"), 0o755);
    const { build, packages } = await checkBundle(context);
    const epoch = await commitEpoch(build.sha);
    const metadata: ImageMetadata = {
      platform,
      created: new Date(Number(epoch) * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/u, "Z"),
      base: await baseImage(),
      build,
      packages,
    };
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    const plan = engine.spec.build({
      containerfile: join(root, "docker", "Containerfile"),
      context,
      platform,
      epoch,
      buildArgs: {
        DRFED_VERSION: build.version,
        DRFED_REVISION: build.sha,
        DRFED_CREATED: metadata.created,
        DRFED_BUILD: JSON.stringify(build),
        DRFED_PACKAGES: JSON.stringify(packages),
        BASE_IMAGE_NAME: metadata.base.name,
        BASE_IMAGE_DIGEST: metadata.base.digest,
      },
      output,
      tag: `localhost/drfed-build-${process.pid}:${arch}`,
    });
    try {
      for (const step of plan.steps) {
        const result = await exec(engine.spec.binary, step.args, {
          cwd: root,
          env: engine.env(step.env),
          timeout: 1_800_000,
          inherit: true,
        });
        assert.equal(
          result.code,
          0,
          `${engine.spec.binary} ${step.args.slice(0, 2).join(" ")} failed`,
        );
      }
    } finally {
      for (const step of plan.cleanup) {
        await exec(engine.spec.binary, step.args, {
          cwd: root,
          env: engine.env(step.env),
        });
      }
    }
    for (const leftover of plan.leftovers) {
      await rm(join(output, leftover), { recursive: true, force: true });
    }
    await singleImage(output);
    await writeFile(
      join(output, metadataFile),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    console.log(
      `Built ${build.version} for ${platform} with ${engine.spec.label} into ${output}`,
    );
    return metadata;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The image:build task declares these with `usage`, so mise passes them
  // as usage_* variables instead of appending them to the command.
  await buildImage({
    engine: process.env.usage_engine,
    artifacts: process.env.usage_artifacts,
    platform: process.env.usage_platform,
    output: process.env.usage_output,
  });
}
