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

// Container image layouts shared by `mise run image:build`,
// `mise run image:test` and the image steps of scripts/release.mts.
// oxlint-disable no-console
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
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

const execute = promisify(execFile);

export const root = fileURLToPath(new URL("../", import.meta.url));
export const imageRepository = "ghcr.io/fedify-dev/drfed";
export const packageOrder = [
  "models",
  "federation",
  "graphql",
  "web",
  "drfed",
] as const;

/** The build identity that scripts/release.mts records in manifest.json. */
export interface Build {
  readonly enabled: boolean;
  readonly version: string;
  readonly fullVersion: string;
  readonly baseVersion: string;
  readonly channel: string;
  readonly sha: string;
  readonly runNumber: string;
  readonly runId: string;
  readonly ref: string;
  readonly workflow: string;
}

/** One packed package, as listed in manifest.json. */
export interface PackageArtifact {
  readonly name: string;
  readonly filename: string;
  readonly integrity: string;
}

/** The manifest.json of a package tarball directory. */
export interface Bundle {
  readonly build: Build;
  readonly packages: readonly PackageArtifact[];
}

/** What a built layout was made from; stored next to its index.json. */
export interface ImageMetadata {
  readonly platform: string;
  readonly created: string;
  readonly base: { readonly name: string; readonly digest: string };
  readonly build: Build;
  readonly packages: readonly PackageArtifact[];
}

/** An OCI descriptor, with only the fields DrFed reads or writes. */
export interface Descriptor {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
  readonly platform?: {
    readonly os: string;
    readonly architecture: string;
    readonly variant?: string;
  };
  readonly annotations?: Readonly<Record<string, string>>;
}

export const metadataFile = "drfed-image.json";
const sha256 = /^sha256:[a-f0-9]{64}$/u;

export async function run(
  binary: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return await execute(binary, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    timeout: 1_800_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function blobPath(layout: string, digest: string): string {
  assert.match(digest, sha256, `Unsupported digest: ${digest}`);
  return join(layout, "blobs", "sha256", digest.slice("sha256:".length));
}

/**
 * Read a blob and check it against its digest.
 * @returns The blob bytes.
 */
export async function readBlob(
  layout: string,
  descriptor: Pick<Descriptor, "digest" | "size">,
): Promise<Buffer> {
  const bytes = await readFile(blobPath(layout, descriptor.digest));
  assert.equal(sha256Digest(bytes), descriptor.digest, "Corrupt layout blob");
  assert.equal(bytes.length, descriptor.size, "Layout blob size mismatch");
  return bytes;
}

export async function writeBlob(
  layout: string,
  bytes: Uint8Array,
): Promise<string> {
  const digest = sha256Digest(bytes);
  await mkdir(join(layout, "blobs", "sha256"), { recursive: true });
  await writeFile(blobPath(layout, digest), bytes);
  return digest;
}

/**
 * Find the single platform image manifest of a layout that image:build wrote.
 * @returns Its descriptor, parsed manifest and config digest.
 */
export async function singleImage(layout: string): Promise<{
  descriptor: Descriptor;
  manifest: { config: Descriptor; layers: Descriptor[] };
}> {
  const index = await readJson<{ manifests: Descriptor[] }>(
    join(layout, "index.json"),
  );
  assert.equal(index.manifests.length, 1, "Expected one image per layout");
  const descriptor = index.manifests[0]!;
  assert.equal(
    descriptor.mediaType,
    "application/vnd.oci.image.manifest.v1+json",
    "Expected an OCI image manifest without attestations",
  );
  const manifest = JSON.parse(
    (await readBlob(layout, descriptor)).toString("utf8"),
  ) as { config: Descriptor; layers: Descriptor[] };
  await readBlob(layout, manifest.config);
  for (const layer of manifest.layers) {
    // oxlint-disable-next-line no-await-in-loop
    await readBlob(layout, layer);
  }
  return { descriptor, manifest };
}

/**
 * The OCI labels and index annotations that tie an image to its packages.
 * @returns The annotation map, identical for labels and index annotations.
 */
export function imageAnnotations(
  metadata: Omit<ImageMetadata, "platform">,
): Record<string, string> {
  return {
    "org.opencontainers.image.title": "DrFed",
    "org.opencontainers.image.description":
      "A web-based platform for developing and debugging ActivityPub apps",
    "org.opencontainers.image.url": "https://drfed.org/",
    "org.opencontainers.image.documentation":
      "https://drfed.org/installation/docker",
    "org.opencontainers.image.source": "https://github.com/fedify-dev/drfed",
    "org.opencontainers.image.licenses": "AGPL-3.0-only",
    "org.opencontainers.image.version": metadata.build.version,
    "org.opencontainers.image.revision": metadata.build.sha,
    "org.opencontainers.image.created": metadata.created,
    "org.opencontainers.image.base.name": metadata.base.name,
    "org.opencontainers.image.base.digest": metadata.base.digest,
    "org.drfed.build": JSON.stringify(metadata.build),
    "org.drfed.packages": JSON.stringify(metadata.packages),
  };
}

/**
 * The base image that docker/Containerfile pins, as OCI base annotations.
 * @returns Its fully qualified name and digest.
 */
export async function baseImage(): Promise<ImageMetadata["base"]> {
  const containerfile = await readFile(
    join(root, "docker", "Containerfile"),
    "utf8",
  );
  const match = /^ARG BASE_IMAGE=(?<name>[^@\s]+)@(?<digest>\S+)$/mu.exec(
    containerfile,
  );
  assert.ok(
    match?.groups,
    "docker/Containerfile must pin BASE_IMAGE by digest",
  );
  assert.match(match.groups.digest!, sha256);
  const name = match.groups.name!;
  const qualified = name.includes("/")
    ? name
    : `docker.io/library/${name.split(":")[0]}:${name.split(":")[1]}`;
  return { name: qualified, digest: match.groups.digest! };
}

async function serverPlatform(): Promise<string> {
  const { stdout } = await run("docker", [
    "version",
    "--format",
    "{{.Server.Os}}/{{.Server.Arch}}",
  ]);
  return stdout.trim();
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
    // oxlint-disable-next-line no-await-in-loop
    const { stdout } = await run(
      "pnpm",
      ["pack", "--json", "--pack-destination", directory],
      { cwd: join(root, "packages", name) },
    );
    const filename = basename(
      (JSON.parse(stdout) as { filename: string }).filename,
    );
    // oxlint-disable-next-line no-await-in-loop
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
    // oxlint-disable-next-line no-await-in-loop
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

export function architecture(platform: string): string {
  const match = /^linux\/(?<arch>amd64|arm64)$/u.exec(platform);
  assert.ok(match?.groups, `Unsupported platform: ${platform}`);
  return match.groups.arch!;
}

/**
 * Build one platform image from a tarball directory into an OCI layout.
 * @returns The written layout's metadata.
 */
export async function buildImage(options: {
  readonly artifacts?: string | undefined;
  readonly platform?: string | undefined;
  readonly output?: string | undefined;
}): Promise<ImageMetadata> {
  const platform = options.platform ?? (await serverPlatform());
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
    const args = [
      "buildx",
      "build",
      "--file",
      join(root, "docker", "Containerfile"),
      "--platform",
      platform,
      "--provenance=false",
      "--sbom=false",
      "--build-arg",
      `DRFED_VERSION=${build.version}`,
      "--build-arg",
      `DRFED_REVISION=${build.sha}`,
      "--build-arg",
      `DRFED_CREATED=${metadata.created}`,
      "--build-arg",
      `DRFED_BUILD=${JSON.stringify(build)}`,
      "--build-arg",
      `DRFED_PACKAGES=${JSON.stringify(packages)}`,
      "--build-arg",
      `BASE_IMAGE_NAME=${metadata.base.name}`,
      "--build-arg",
      `BASE_IMAGE_DIGEST=${metadata.base.digest}`,
      "--output",
      `type=oci,dest=${output},tar=false,rewrite-timestamp=true`,
      context,
    ];
    const child = spawn("docker", args, {
      cwd: root,
      env: { ...process.env, SOURCE_DATE_EPOCH: epoch },
      stdio: "inherit",
    });
    // The once() call rejects when the child emits "error" first.
    const [code] = (await once(child, "close")) as [number | null];
    assert.equal(code, 0, "docker buildx build failed");
    // BuildKit leaves its empty ingest directory, which is not layout content.
    await rm(join(output, "ingest"), { recursive: true, force: true });
    await singleImage(output);
    await writeFile(
      join(output, metadataFile),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    console.log(`Built ${build.version} for ${platform} into ${output}`);
    return metadata;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "build") {
    // The image:build task declares these with `usage`, so mise passes them
    // as usage_* variables instead of appending them to the command.
    await buildImage({
      artifacts: process.env.usage_artifacts,
      platform: process.env.usage_platform,
      output: process.env.usage_output,
    });
  } else {
    throw new Error("Expected build");
  }
}
