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

// The container engines that image:build and the test:image:* tasks drive,
// as data and pure calculations.  Engine names appear only here and in
// mise.toml; the documentation build imports forEngine() from this file, so
// it must stay free of runtime Node.js imports.

/** One command line of an engine, after its binary. */
export interface EngineCommand {
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** What image:build hands an engine to build one platform image. */
export interface BuildInput {
  readonly containerfile: string;
  readonly context: string;
  readonly platform: string;
  /** Seconds since the epoch for every image and layer timestamp. */
  readonly epoch: string;
  readonly buildArgs: Readonly<Record<string, string>>;
  /** An empty directory that receives the OCI image layout. */
  readonly output: string;
  /** A local name the engine may use while building. */
  readonly tag: string;
}

/** The commands that build an OCI layout, and those that always clean up. */
export interface BuildPlan {
  readonly steps: readonly EngineCommand[];
  readonly cleanup: readonly EngineCommand[];
  /** Paths below the layout that the engine leaves but are not content. */
  readonly leftovers: readonly string[];
}

/** One container engine. */
export interface EngineSpec {
  readonly name: string;
  /** The engine's name in messages. */
  readonly label: string;
  readonly binary: string;
  /** The arguments that run its Compose Specification implementation. */
  readonly compose: readonly string[];
  /** The environment the engine and its Compose provider run with. */
  readonly env: (processEnv: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  /** Arguments that fail when the engine cannot be reached. */
  readonly info: readonly string[];
  /** Arguments that print the engine's server platform as OS/ARCH. */
  readonly platform: readonly string[];
  readonly build: (input: BuildInput) => BuildPlan;
}

const buildArgs = (input: BuildInput): readonly string[] =>
  Object.entries(input.buildArgs).flatMap(([key, value]) => [
    "--build-arg",
    `${key}=${value}`,
  ]);

const docker: EngineSpec = {
  name: "docker",
  label: "Docker",
  binary: "docker",
  compose: ["compose"],
  env: (processEnv) => ({ ...processEnv }),
  info: ["info", "--format", "{{.ServerVersion}}"],
  platform: ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"],
  // The oci exporter needs the containerd image store or a docker-container
  // builder; BuildKit writes no attestations with these flags.
  build: (input) => ({
    steps: [
      {
        args: [
          "buildx",
          "build",
          "--file",
          input.containerfile,
          "--platform",
          input.platform,
          "--provenance=false",
          "--sbom=false",
          ...buildArgs(input),
          "--output",
          `type=oci,dest=${input.output},tar=false,rewrite-timestamp=true`,
          input.context,
        ],
        env: { SOURCE_DATE_EPOCH: input.epoch },
      },
    ],
    cleanup: [],
    // BuildKit leaves its empty ingest directory.
    leftovers: ["ingest"],
  }),
};

const podman: EngineSpec = {
  name: "podman",
  label: "Podman",
  binary: "podman",
  compose: ["compose"],
  // An existing DOCKER_HOST reaches the Compose provider unchanged, which would
  // then drive another engine.  The provider notice would go to stderr.
  env: ({ DOCKER_HOST: _, ...processEnv }) => ({
    ...processEnv,
    PODMAN_COMPOSE_WARNING_LOGS: "false",
  }),
  info: ["info", "--format", "{{.Version.Version}}"],
  platform: ["info", "--format", "{{.Host.OS}}/{{.Host.Arch}}"],
  // --timestamp is also in older Podman releases than --source-date-epoch.
  // Without --layers=false, every build keeps its intermediate stage images.
  // Saving to oci-dir compresses layers with gzip like the Docker path, and
  // unlike pushing to oci:, it also works through a remote Podman client.
  build: (input) => ({
    steps: [
      {
        args: [
          "build",
          "--file",
          input.containerfile,
          "--platform",
          input.platform,
          "--timestamp",
          input.epoch,
          "--identity-label=false",
          "--layers=false",
          ...buildArgs(input),
          "--tag",
          input.tag,
          input.context,
        ],
      },
      {
        args: [
          "save",
          "--format",
          "oci-dir",
          "--output",
          input.output,
          input.tag,
        ],
      },
    ],
    cleanup: [{ args: ["image", "rm", "--force", input.tag] }],
    leftovers: [],
  }),
};

/** The supported engines, in the order image:build tries them. */
export const engines: Readonly<Record<string, EngineSpec>> = {
  docker,
  podman,
};

/**
 * Look up an engine by name.
 * @returns The engine.
 */
export function engineSpec(name: string): EngineSpec {
  const spec = Object.hasOwn(engines, name) ? engines[name] : undefined;
  if (spec === undefined) {
    throw new Error(
      `Unknown container engine ${JSON.stringify(name)}; expected one of ${Object.keys(engines).join(", ")}.`,
    );
  }
  return spec;
}

const architectures: Readonly<Record<string, string>> = {
  aarch64: "arm64",
  arm64: "arm64",
  amd64: "amd64",
  x86_64: "amd64",
};

/**
 * Normalize what an engine reports as its platform.
 * @returns The platform as linux/amd64 or linux/arm64 spelling.
 */
export function normalizePlatform(reported: string): string {
  const [os = "", arch = ""] = reported.trim().toLowerCase().split("/");
  return `${os}/${architectures[arch] ?? arch}`;
}

/**
 * Normalize an image ID, which Podman prints without its algorithm.
 * @returns The ID as a sha256: digest.
 */
export function normalizeImageId(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith("sha256:") ? trimmed : `sha256:${trimmed}`;
}

/**
 * The digests a loaded layout image can be found by.  The containerd image
 * store of Docker keeps the manifest digest as the image ID; the classic
 * store and Podman keep the config digest, which covers every layer through
 * its diff IDs.
 * @returns The manifest digest, then the config digest.
 */
export function imageIdCandidates(image: {
  readonly descriptor: { readonly digest: string };
  readonly manifest: { readonly config: { readonly digest: string } };
}): readonly string[] {
  return [image.descriptor.digest, image.manifest.config.digest];
}

const leadingDocker = /^(?<indent>[ \t]*)docker(?=[ \t])/gmu;

/**
 * Rewrite a shell snippet written for Docker to run the given engine.  Only a
 * docker command at the start of a line changes, so the documentation shows
 * exactly the text that the container tests run.
 * @returns The snippet for that engine.
 */
export function forEngine(snippet: string, name: string): string {
  const { binary } = engineSpec(name);
  return snippet.replaceAll(leadingDocker, `$<indent>${binary}`);
}
