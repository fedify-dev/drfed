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

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  engineSpec,
  forEngine,
  imageIdCandidates,
  normalizeImageId,
  normalizePlatform,
} from "./engines.mts";
import { root } from "./layout.mts";

describe("forEngine()", () => {
  it("keeps Docker snippets as they are", async () => {
    const backup = await readFile(join(root, "docker", "backup.sh"), "utf8");
    assert.equal(forEngine(backup, "docker"), backup);
  });

  it("rewrites every docker command of the snippets", async () => {
    for (const file of ["backup.sh", "restore.sh"]) {
      // oxlint-disable-next-line no-await-in-loop
      const snippet = await readFile(join(root, "docker", file), "utf8");
      const podman = forEngine(snippet, "podman");
      assert.equal(
        podman.match(/\bpodman compose\b/gu)?.length,
        snippet.match(/\bdocker compose\b/gu)?.length,
      );
      assert.doesNotMatch(podman, /\bdocker compose\b/u);
    }
  });

  it("rewrites inline commands and indented lines only", () => {
    assert.equal(
      forEngine(
        "docker compose run --rm drfed drfed-migrate --check",
        "podman",
      ),
      "podman compose run --rm drfed drfed-migrate --check",
    );
    assert.equal(
      forEngine("  docker pull ghcr.io/fedify-dev/drfed:latest", "podman"),
      "  podman pull ghcr.io/fedify-dev/drfed:latest",
    );
    assert.equal(
      forEngine("id=$(docker compose ps --quiet drfed)", "podman"),
      "id=$(podman compose ps --quiet drfed)",
    );
    for (const text of [
      "docker/backup.sh",
      "dockerd --help",
      "# Use docker compose here",
      "echo docker compose",
      "echo $(echo docker compose)",
    ]) {
      assert.equal(forEngine(text, "podman"), text);
    }
  });

  it("rejects unknown engines", () => {
    assert.throws(() => forEngine("docker ps", "toString"), /Unknown/u);
  });
});

describe("normalizePlatform()", () => {
  it("spells architectures the way OCI platforms do", () => {
    assert.equal(normalizePlatform("linux/aarch64\n"), "linux/arm64");
    assert.equal(normalizePlatform("linux/x86_64"), "linux/amd64");
    assert.equal(normalizePlatform("linux/arm64"), "linux/arm64");
    assert.equal(normalizePlatform("linux/amd64"), "linux/amd64");
  });
});

describe("normalizeImageId()", () => {
  it("adds the algorithm that Podman leaves out", () => {
    const hex = "a".repeat(64);
    assert.equal(normalizeImageId(`${hex}\n`), `sha256:${hex}`);
    assert.equal(normalizeImageId(`sha256:${hex}`), `sha256:${hex}`);
  });
});

describe("imageIdCandidates()", () => {
  it("tries the manifest digest before the config digest", () => {
    assert.deepEqual(
      imageIdCandidates({
        descriptor: { digest: "sha256:manifest" },
        manifest: { config: { digest: "sha256:config" } },
      }),
      ["sha256:manifest", "sha256:config"],
    );
  });
});

describe("engine environments", () => {
  it("keep Podman's Compose provider off another engine's socket", () => {
    const env = engineSpec("podman").env({
      DOCKER_HOST: "unix:///var/run/docker.sock",
      PATH: "/usr/bin",
    });
    assert.equal(env.DOCKER_HOST, undefined);
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.PODMAN_COMPOSE_WARNING_LOGS, "false");
  });

  it("leave Docker's environment alone", () => {
    const processEnv = { DOCKER_HOST: "tcp://example:2375" };
    assert.deepEqual(engineSpec("docker").env(processEnv), processEnv);
  });
});

describe("build plans", () => {
  const input = {
    containerfile: "/src/docker/Containerfile",
    context: "/tmp/context",
    platform: "linux/arm64",
    epoch: "1700000000",
    buildArgs: { DRFED_VERSION: "0.2.0" },
    output: "/out/linux-arm64",
    tag: "localhost/drfed-build-1:arm64",
  };

  it("export an OCI layout with Docker Buildx", () => {
    const plan = engineSpec("docker").build(input);
    assert.equal(plan.steps.length, 1);
    assert.deepEqual(plan.steps[0]!.env, { SOURCE_DATE_EPOCH: "1700000000" });
    assert.ok(
      plan.steps[0]!.args.includes(
        "type=oci,dest=/out/linux-arm64,tar=false,rewrite-timestamp=true",
      ),
    );
    assert.deepEqual(plan.cleanup, []);
  });

  it("build, save as an oci-dir layout and untag with Podman", () => {
    const plan = engineSpec("podman").build(input);
    assert.deepEqual(
      plan.steps.map(({ args }) => args[0]),
      ["build", "save"],
    );
    assert.ok(plan.steps[0]!.args.includes("--identity-label=false"));
    assert.ok(plan.steps[0]!.args.includes("--layers=false"));
    assert.deepEqual(plan.steps[1]!.args, [
      "save",
      "--format",
      "oci-dir",
      "--output",
      "/out/linux-arm64",
      "localhost/drfed-build-1:arm64",
    ]);
    assert.deepEqual(plan.cleanup, [
      { args: ["image", "rm", "--force", "localhost/drfed-build-1:arm64"] },
    ]);
  });
});
