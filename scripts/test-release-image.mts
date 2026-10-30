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

// Exercise the container image steps of scripts/release.mts against stub
// crane and gh commands: index composition, immutable pushes, channel
// ordering, and attestation recovery.  No Docker daemon is needed.
// oxlint-disable no-console no-await-in-loop node/no-top-level-await
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("./release.mts", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "drfed-release-image-"));
const root = join(temporary, "repo");
const archives = join(root, "release-artifacts");
const images = join(root, "image-artifacts");
const names = ["models", "federation", "graphql", "web", "drfed"];
const workflow = ".github/workflows/main.yaml";

interface Build {
  enabled: boolean;
  version: string;
  fullVersion: string;
  baseVersion: string;
  channel: string;
  sha: string;
  runNumber: string;
  runId: string;
  ref: string;
  workflow: string;
}
interface Bundle {
  mediaType: string;
  workflow: string;
}

// Registry state: tags name digests, digests hold manifest bytes.
const manifests = new Map<string, string>();
const tags = new Map<string, string>();
const craneCalls: string[][] = [];
let craneFailures = 0;
// Anonymous reads: refused while the package is private, or failing.
let publicPackage = true;
let anonymousFailures = 0;
const anonymousReads: string[] = [];
// Attestation state per subject digest.
const github = new Map<string, Bundle[]>();
const attached = new Map<string, Record<string, unknown>>();
let ghFailures = 0;

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function answer(
  code: number,
  stdout = "",
  stderr = "",
): { code: number; stdout: string; stderr: string } {
  return { code, stdout, stderr };
}

async function handleCrane(args: string[], dockerConfig?: string) {
  craneCalls.push(args);
  if (dockerConfig !== undefined) {
    // The release script reads anonymously through an empty DOCKER_CONFIG.
    assert.deepEqual(await readdir(dockerConfig), []);
    anonymousReads.push(args[1]!);
    if (anonymousFailures > 0) {
      anonymousFailures -= 1;
      return answer(1, "", "Get: dial tcp: i/o timeout");
    }
    if (!publicPackage) {
      return answer(1, "", "UNAUTHORIZED: authentication required");
    }
  }
  if (craneFailures > 0) {
    craneFailures -= 1;
    return answer(1, "", "Get: read: connection reset by peer");
  }
  const missing = answer(1, "", "MANIFEST_UNKNOWN: manifest unknown");
  const [command, target] = args;
  const tag = target!.split(":").at(-1)!;
  if (command === "digest") {
    const digest = tags.get(tag);
    return digest ? answer(0, `${digest}\n`) : missing;
  }
  if (command === "manifest") {
    const digest = tags.get(tag);
    return digest ? answer(0, manifests.get(digest)!) : missing;
  }
  if (command === "push") {
    const layout = target!;
    const reference = args[2]!;
    const index = JSON.parse(
      await readFile(join(layout, "index.json"), "utf8"),
    ) as { manifests: { digest: string }[] };
    assert.equal(index.manifests.length, 1);
    const { digest } = index.manifests[0]!;
    const bytes = await readFile(
      join(layout, "blobs", "sha256", digest.slice(7)),
      "utf8",
    );
    assert.equal(sha256(bytes), digest);
    manifests.set(digest, bytes);
    tags.set(reference.split(":").at(-1)!, digest);
    const refs = args[args.indexOf("--image-refs") + 1]!;
    await writeFile(
      refs,
      `${reference.split(":")[0]}:${reference.split(":")[1]}@${digest}\n`,
    );
    return answer(0);
  }
  if (command === "tag") {
    const digest = target!.split("@")[1]!;
    assert.ok(manifests.has(digest));
    tags.set(args[2]!, digest);
    return answer(0);
  }
  throw new Error(`Unexpected crane ${args.join(" ")}`);
}

function constraintsHold(args: string[], build: Build): boolean {
  const value = (name: string) => args[args.indexOf(name) + 1];
  return (
    value("--repo") === "fedify-dev/drfed" &&
    value("--signer-workflow") === `fedify-dev/drfed/${workflow}` &&
    value("--source-ref") === build.ref &&
    value("--source-digest") === build.sha &&
    value("--predicate-type") === "https://slsa.dev/provenance/v1" &&
    args.includes("--deny-self-hosted-runners")
  );
}

let currentBuild: Build;
async function handleGh(args: string[], cwd: string) {
  if (ghFailures > 0) {
    ghFailures -= 1;
    return answer(
      1,
      "",
      "Error: HTTP 502: Bad Gateway (https://api.github.com/)",
    );
  }
  assert.equal(args[0], "attestation");
  const digest = args[2]!.split("@")[1]!;
  if (args[1] === "download") {
    const bundles = github.get(digest) ?? [];
    if (bundles.length === 0) {
      return answer(1, "", "Error: HTTP 404: Not Found");
    }
    await writeFile(
      join(cwd, `${digest}.jsonl`),
      bundles.map((bundle) => JSON.stringify(bundle)).join("\n"),
    );
    return answer(0);
  }
  assert.equal(args[1], "verify");
  assert.ok(constraintsHold(args, currentBuild), args.join(" "));
  const valid = (bundle: Bundle) => bundle.workflow === workflow;
  if (args.includes("--bundle")) {
    const bundle = JSON.parse(
      await readFile(args[args.indexOf("--bundle") + 1]!, "utf8"),
    ) as Bundle;
    return valid(bundle)
      ? answer(0)
      : answer(1, "", "Error: verifying with issuer: signer workflow mismatch");
  }
  if (args.includes("--bundle-from-oci")) {
    return attached.has(digest)
      ? answer(0)
      : answer(
          1,
          "",
          "Error: no attestations found in the OCI registry. Retry the command without the --bundle-from-oci flag to check GitHub for the attestation",
        );
  }
  const stored = github.get(digest) ?? [];
  if (stored.length === 0) {
    return answer(
      1,
      "",
      "Error: HTTP 404: Not Found (https://api.github.com/)",
    );
  }
  return stored.some(valid)
    ? answer(0)
    : answer(1, "", "Error: verifying with issuer: signer workflow mismatch");
}

const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
    args: string[];
    cwd: string;
    dockerConfig?: string;
  } & Record<string, unknown>;
  try {
    if (request.url === "/__attach") {
      attached.set(body.imageDigest as string, body);
      response.end("{}");
      return;
    }
    const result =
      request.url === "/__crane"
        ? await handleCrane(body.args, body.dockerConfig)
        : await handleGh(body.args, body.cwd);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const endpoint = `http://127.0.0.1:${address.port}/`;
const repository = `127.0.0.1:${address.port}/drfed`;

const bin = join(temporary, "bin");
await mkdir(bin);
for (const name of ["crane", "gh"]) {
  await writeFile(
    join(bin, name),
    `#!/usr/bin/env node
const response = await fetch(${JSON.stringify(`${endpoint}__${name}`)}, {
  method: "POST",
  body: JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    dockerConfig: process.env.DOCKER_CONFIG,
  }),
});
if (!response.ok) { console.error(await response.text()); process.exit(2); }
const { code, stdout, stderr } = await response.json();
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = code;
`,
    { mode: 0o755 },
  );
}
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:ACTIONS_|GH_TOKEN|GITHUB_|GIT_)/u.test(key),
    ),
  ),
  PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  GITHUB_EVENT_NAME: "push",
  GITHUB_REPOSITORY: "fedify-dev/drfed",
};

async function run(args: string[]): Promise<{
  stdout: string;
  outputs: Record<string, string>;
}> {
  const output = join(temporary, "github-output");
  await writeFile(output, "");
  const { stdout } = await execute(
    process.execPath,
    [
      script,
      ...args,
      "--root",
      root,
      "--artifacts",
      archives,
      "--images",
      images,
      "--image-repository",
      repository,
      "--fixture",
      "--registry",
      endpoint,
      "--remote",
      join(temporary, "remote"),
    ],
    {
      cwd: root,
      env: {
        ...env,
        GITHUB_OUTPUT: output,
        DRFED_RELEASE_BUILD: JSON.stringify(currentBuild),
        GITHUB_REF: currentBuild.ref,
        GITHUB_RUN_NUMBER: currentBuild.runNumber,
        GITHUB_RUN_ID: currentBuild.runId,
      },
      timeout: 120_000,
    },
  );
  const outputs = Object.fromEntries(
    (await readFile(output, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  return { stdout, outputs };
}

function buildOf(version: string, runNumber: string, sha: string): Build {
  const release = !version.includes("-dev.");
  return {
    enabled: true,
    version,
    fullVersion: release ? version : `${version}+${sha.slice(0, 8)}`,
    baseVersion: version.replace(/-.*$/u, ""),
    channel: release ? (version.includes("-") ? "next" : "latest") : "dev",
    sha,
    runNumber,
    runId: `${runNumber}00`,
    ref: release ? `refs/tags/${version}` : "refs/heads/main",
    workflow,
  };
}

/** Write fake tarballs and per-platform layouts for one build. */
async function prepare(build: Build): Promise<void> {
  await rm(archives, { recursive: true, force: true });
  await rm(images, { recursive: true, force: true });
  await mkdir(archives, { recursive: true });
  const packages = [];
  for (const name of names) {
    const filename = `drfed-${name}-${build.version}.tgz`;
    const bytes = randomBytes(64);
    await writeFile(join(archives, filename), bytes);
    packages.push({
      name: `@drfed/${name}`,
      filename,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    });
  }
  await writeFile(
    join(archives, "manifest.json"),
    JSON.stringify({ build, packages }),
  );
  for (const arch of ["amd64", "arm64"]) {
    const layout = join(images, `linux-${arch}`);
    await mkdir(join(layout, "blobs", "sha256"), { recursive: true });
    const blob = async (bytes: Buffer) => {
      const digest = sha256(bytes);
      await writeFile(join(layout, "blobs", "sha256", digest.slice(7)), bytes);
      return { digest, size: bytes.length };
    };
    const config = await blob(Buffer.from(JSON.stringify({ arch })));
    const layer = await blob(randomBytes(128));
    const manifest = await blob(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          config: {
            mediaType: "application/vnd.oci.image.config.v1+json",
            ...config,
          },
          layers: [
            {
              mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
              ...layer,
            },
          ],
        }),
      ),
    );
    await writeFile(
      join(layout, "index.json"),
      JSON.stringify({
        schemaVersion: 2,
        manifests: [
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            ...manifest,
            platform: { architecture: arch, os: "linux" },
          },
        ],
      }),
    );
    await writeFile(
      join(layout, "oci-layout"),
      '{"imageLayoutVersion":"1.0.0"}',
    );
    await writeFile(
      join(layout, "drfed-image.json"),
      JSON.stringify({
        platform: `linux/${arch}`,
        created: "2026-10-25T07:23:03Z",
        base: {
          name: "docker.io/library/node:26.12.1-trixie-slim",
          digest: `sha256:${"0".repeat(64)}`,
        },
        build,
        packages,
      }),
    );
  }
}

/**
 * Point a channel tag at an index of some other build.
 * @returns The digest of that index.
 */
function seedChannel(channel: string, build: Build | undefined): string {
  const bytes = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [],
    ...(build
      ? { annotations: { "org.drfed.build": JSON.stringify(build) } }
      : {}),
  });
  const digest = sha256(bytes);
  manifests.set(digest, bytes);
  tags.set(channel, digest);
  return digest;
}

try {
  await mkdir(root);
  const sha = "1".repeat(40);
  currentBuild = buildOf("0.2.0-dev.7", "7", sha);
  await prepare(currentBuild);

  // Index composition is deterministic and reruns verify the stored copy.
  const indexed = await run(["image-index"]);
  const digest = indexed.outputs.digest!;
  assert.match(digest, /^sha256:[a-f0-9]{64}$/u);
  const imageManifest = JSON.parse(
    await readFile(join(images, "index", "image-manifest.json"), "utf8"),
  );
  assert.equal(imageManifest.digest, digest);
  assert.deepEqual(
    imageManifest.platforms.map((item: { platform: string }) => item.platform),
    ["linux/amd64", "linux/arm64"],
  );
  const index = JSON.parse(
    await readFile(
      join(images, "index", "blobs", "sha256", digest.slice(7)),
      "utf8",
    ),
  );
  assert.deepEqual(
    JSON.parse(index.annotations["org.drfed.build"]),
    currentBuild,
  );
  assert.equal(
    index.annotations["org.opencontainers.image.version"],
    "0.2.0-dev.7",
  );
  assert.equal((await run(["image-index"])).outputs.digest, digest);
  const metadataPath = join(images, "linux-arm64", "drfed-image.json");
  const metadata = await readFile(metadataPath, "utf8");
  await writeFile(
    metadataPath,
    metadata.replace('"runNumber":"7"', '"runNumber":"8"'),
  );
  await assert.rejects(run(["image-index"]), /Image of another build/u);
  await writeFile(metadataPath, metadata);

  // Pushes are immutable, retried on transient failures, and idempotent.
  craneFailures = 2;
  const pushed = await run(["image-push"]);
  assert.equal(pushed.outputs.digest, digest);
  assert.equal(tags.get("0.2.0-dev.7"), digest);
  assert.match((await run(["image-push"])).stdout, /already exists/u);
  tags.set("0.2.0-dev.7", seedChannel("scratch", undefined));
  tags.delete("scratch");
  await assert.rejects(
    run(["image-push"]),
    /Immutable image version conflict/u,
  );
  tags.set("0.2.0-dev.7", digest);
  const layout = join(images, "linux-amd64");
  await rename(layout, `${layout}.missing`);
  await assert.rejects(run(["image-push"]), /ENOENT/u);
  await rename(`${layout}.missing`, layout);

  // Channel tags only move forward, and foreign images stop the run.
  const newer = seedChannel("dev", buildOf("0.2.0-dev.9", "9", sha));
  assert.match((await run(["image-tags"])).stdout, /preserving/u);
  assert.equal(tags.get("dev"), newer);
  seedChannel("dev", undefined);
  await assert.rejects(run(["image-tags"]), /Cannot order a foreign image/u);
  seedChannel("dev", {
    ...buildOf("0.2.0-dev.3", "3", sha),
    workflow: "other.yaml",
  });
  await assert.rejects(
    run(["image-tags"]),
    /Cannot order a foreign dev build/u,
  );
  seedChannel("dev", buildOf("0.2.0-dev.3", "3", sha));
  tags.set("0.2.0-dev.7", digest);
  await run(["image-tags"]);
  assert.equal(tags.get("dev"), digest);
  assert.match((await run(["image-tags"])).stdout, /already names/u);
  assert.equal(anonymousReads.at(-1), `${repository}:dev`);
  // A private package only warns on main, so the first dev build can finish
  // before a maintainer makes the package public.
  publicPackage = false;
  assert.match(
    (await run(["image-tags"])).stdout,
    /::warning::Anonymous pull of .*:dev is refused/u,
  );
  publicPackage = true;
  anonymousFailures = 3;
  await assert.rejects(run(["image-tags"]), /i\/o timeout/u);
  anonymousFailures = 2;
  await run(["image-tags"]);

  // Attestation recovery: GitHub first, then the registry copy.
  assert.equal(
    (await run(["image-attestation", "status"])).outputs.state,
    "none",
  );
  await assert.rejects(run(["image-attestation", "verify"]), /must verify/u);
  github.set(digest, [
    {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      workflow: "other.yaml",
    },
    { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", workflow },
  ]);
  ghFailures = 1;
  assert.equal(
    (await run(["image-attestation", "status"])).outputs.state,
    "github-only",
  );
  await run(["image-attestation", "attach"]);
  const attachment = attached.get(digest)!;
  assert.equal(attachment.imageName, repository);
  assert.equal(
    attachment.mediaType,
    "application/vnd.dev.sigstore.bundle.v0.3+json",
  );
  assert.deepEqual(attachment.annotations, {
    "dev.sigstore.bundle.content": "dsse-envelope",
    "dev.sigstore.bundle.predicateType": "https://slsa.dev/provenance/v1",
  });
  assert.equal(
    JSON.parse(
      Buffer.from((attachment.artifact as { data: number[] }).data).toString(),
    ).workflow,
    workflow,
  );
  assert.equal(
    (await run(["image-attestation", "status"])).outputs.state,
    "both",
  );
  await run(["image-attestation", "verify"]);
  await assert.rejects(run(["image-attestation", "attach"]));
  github.set(digest, []);
  await assert.rejects(
    run(["image-attestation", "status"]),
    /Registry-only attestation/u,
  );
  github.set(digest, [{ mediaType: "x", workflow: "other.yaml" }]);
  attached.delete(digest);
  // Attestations by another workflow are not absence; the run stops.
  await assert.rejects(
    run(["image-attestation", "status"]),
    /signer workflow mismatch/u,
  );
  console.log("Dev image index, push, channel and attestation fixtures passed");

  // Release channels compare SemVer and recheck the remote tag before writes.
  const remote = join(temporary, "remote");
  await mkdir(remote);
  const git = (...args: string[]) =>
    execute("git", args, {
      cwd: remote,
      env: {
        ...env,
        GIT_CONFIG_GLOBAL: join(temporary, "gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  await writeFile(join(temporary, "gitconfig"), "");
  await git("init", "--quiet");
  await git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "release",
  );
  const releaseSha = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("tag", "0.2.0");
  currentBuild = buildOf("0.2.0", "11", releaseSha);
  await prepare(currentBuild);
  const released = (await run(["image-index"])).outputs.digest!;
  await run(["image-push"]);
  const later = seedChannel("latest", buildOf("0.3.0", "20", releaseSha));
  assert.match((await run(["image-tags"])).stdout, /preserving/u);
  assert.equal(tags.get("latest"), later);
  seedChannel("latest", buildOf("0.1.0", "5", releaseSha));
  await git(
    "tag",
    "--force",
    "0.2.0",
    (
      await git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit-tree",
        "-m",
        "moved",
        `${releaseSha}^{tree}`,
      )
    ).stdout.trim(),
  );
  await assert.rejects(
    run(["image-tags"]),
    /Remote tag was deleted or retargeted/u,
  );
  // Attaching a stored attestation also writes to the registry.
  github.set(released, [
    { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", workflow },
  ]);
  await assert.rejects(
    run(["image-attestation", "attach"]),
    /Remote tag was deleted or retargeted/u,
  );
  assert.ok(!attached.has(released));
  await git("tag", "--force", "0.2.0", releaseSha);
  await run(["image-attestation", "attach"]);
  assert.ok(attached.has(released));
  publicPackage = false;
  await assert.rejects(run(["image-tags"]), /make the package public/u);
  assert.equal(tags.get("latest"), released);
  publicPackage = true;
  await run(["image-tags"]);
  assert.equal(tags.get("latest"), released);
  console.log("Release image channel fixtures passed");
} finally {
  server.close();
  await rm(temporary, { recursive: true, force: true });
}
