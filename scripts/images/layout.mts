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

// Container image layouts and their metadata, shared by
// `mise run image:build`, the test:image:* tasks and the image steps of
// scripts/release.mts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
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

/** What the top level of a directory holds, as far as a layout check needs. */
export interface LayoutContents {
  /** Each entry's kind, from lstat, so that symbolic links are "other". */
  readonly entries: ReadonlyMap<string, "file" | "directory" | "other">;
  /** The parsed files; undefined when missing or not valid JSON. */
  readonly ociLayout?: unknown;
  readonly index?: unknown;
  readonly metadata?: unknown;
}

const layoutEntries = new Map([
  ["blobs", "directory"],
  ["drfed-image.json", "file"],
  ["index.json", "file"],
  ["oci-layout", "file"],
] as const);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Check that a directory holds exactly a layout that image:build wrote: the
 * OCI layout files, its blobs, and DrFed's own metadata, and nothing else.
 * Another project's layout lacks the metadata, so it is never mistaken for
 * one.
 * @returns Why the directory is not such a layout, or undefined if it is.
 */
export function drfedLayoutProblem(
  contents: LayoutContents,
): string | undefined {
  const names = [...contents.entries.keys()].sort();
  const expected = [...layoutEntries.keys()].sort();
  if (names.join("\0") !== expected.join("\0")) {
    const shown =
      names.length > 5
        ? `${names.slice(0, 5).join(", ")} and ${names.length - 5} more`
        : names.join(", ");
    return `it holds ${shown} instead of exactly ${expected.join(", ")}`;
  }
  for (const [name, kind] of layoutEntries) {
    if (contents.entries.get(name) !== kind) return `${name} is not a ${kind}`;
  }
  if (
    !isRecord(contents.ociLayout) ||
    contents.ociLayout.imageLayoutVersion !== "1.0.0"
  ) {
    return "oci-layout is not an OCI image layout 1.0.0 marker";
  }
  if (
    !isRecord(contents.index) ||
    contents.index.schemaVersion !== 2 ||
    !Array.isArray(contents.index.manifests)
  ) {
    return "index.json is not an OCI image index";
  }
  const { metadata } = contents;
  const packages =
    isRecord(metadata) && Array.isArray(metadata.packages)
      ? metadata.packages.map((item) => (isRecord(item) ? item.name : item))
      : undefined;
  if (
    !isRecord(metadata) ||
    typeof metadata.platform !== "string" ||
    !isRecord(metadata.build) ||
    packages?.join() !== packageOrder.map((name) => `@drfed/${name}`).join()
  ) {
    return `${metadataFile} does not describe a DrFed image`;
  }
  return undefined;
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
      "https://drfed.org/installation/container",
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

export function architecture(platform: string): string {
  const match = /^linux\/(?<arch>amd64|arm64)$/u.exec(platform);
  assert.ok(match?.groups, `Unsupported platform: ${platform}`);
  return match.groups.arch!;
}
