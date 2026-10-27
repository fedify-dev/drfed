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

import { isIP } from "node:net";

import { object, or } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { map, optional, withDefault } from "@optique/core/modifiers";
import type { InferValue } from "@optique/core/parser";
import { flag, option } from "@optique/core/primitives";
import { origin, socketAddress } from "@optique/core/valueparser";
import { textFormatter } from "@optique/logtape";
import { path } from "@optique/run/valueparser";

import {
  configurationBoolean,
  configurationProjection,
  configurationProvenance,
  createConfigurationBindings,
  lazyDefault,
  configurationSettings as settings,
} from "../configuration.ts";
import { defaultListenHost } from "../listen-defaults.ts";
import { createLoggingParser, resolveLogging } from "../logging.ts";

/** Build a web-only CLI from the shared TOML and environment registry.
 * @returns Pure metadata, parser contexts and the configuration loader.
 */
export function createWebProgram(
  options: Parameters<typeof createConfigurationBindings>[0] = {},
) {
  const bindings = createConfigurationBindings(options);
  const { bind } = bindings;
  const webOrigin = origin({ allowedProtocols: ["http:", "https:"] });
  const address = socketAddress({ requirePort: true });
  const parser = object({
    configPath: optional(
      bindings.bindConfigPath(
        option("--config", path({ metavar: "FILE", type: "file" }), {
          description: message`Read the shared DrFed TOML configuration file.`,
        }),
      ),
    ),
    publicOrigin: bind(
      option("--public-origin", webOrigin, {
        description: message`The public HTTP or HTTPS web origin, including the external scheme behind TLS termination. Required.`,
      }),
      settings.publicOrigin,
      webOrigin,
      String,
    ),
    backendUrl: bind(
      option("--backend-url", webOrigin, {
        description: message`The backend origin. HTTPS is required outside loopback unless explicitly allowed. GraphQL requests target its /graphql endpoint. Required.`,
      }),
      settings.backendUrl,
      webOrigin,
      String,
    ),
    allowInsecureBackend: bind(
      or(
        flag("--allow-insecure-backend", {
          description: message`Allow HTTP to a non-loopback backend only on a trusted internal network. Session tokens travel without encryption.`,
        }),
        map(
          flag("--no-allow-insecure-backend", {
            description: message`Require HTTPS for non-loopback backends, overriding environment and configuration permission.`,
          }),
          () => false,
        ),
      ),
      settings.allowInsecureBackend,
      configurationBoolean(),
      String,
      false,
    ),
    address: bind(
      option("--listen", "-l", address, {
        description: message`The web address to listen on; independent of the backend server listen setting.`,
      }),
      settings.webListen,
      address,
      String,
      lazyDefault(() => ({
        host: defaultListenHost(bindings.env),
        port: 3000,
      })),
    ),
    logging: createLoggingParser(bindings),
    printConfig: withDefault(
      flag("--print-config", {
        description: message`Print effective settings and provenance, then exit without starting the web runtime or opening logging outputs.`,
      }),
      false,
    ),
  });
  return {
    program: {
      metadata: {
        name: "drfed-web",
        description: message`Run the DrFed web frontend with a separately running GraphQL backend.`,
      },
      parser,
    },
    contexts: bindings.contexts,
    load: bindings.load,
  };
}

type RawWebOptions = InferValue<
  ReturnType<typeof createWebProgram>["program"]["parser"]
>;

/** Resolve operational web settings before acquiring resources.
 * @returns The web-only deployment and logging settings with provenance.
 */
export function resolveWebOptions(raw: RawWebOptions, cwd = process.cwd()) {
  const publicOrigin = raw.publicOrigin?.value;
  const backendUrl = raw.backendUrl?.value;
  const address = raw.address?.value;
  if (publicOrigin === undefined) {
    throw new Error(
      "Missing --public-origin, DRFED_PUBLIC_ORIGIN or web.public_origin.",
    );
  }
  if (backendUrl === undefined) {
    throw new Error(
      "Missing --backend-url, DRFED_BACKEND_URL or web.backend_url.",
    );
  }
  const allowInsecureBackend = raw.allowInsecureBackend?.value ?? false;
  const hostname = backendUrl.hostname;
  const loopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    (isIP(hostname) === 4 && hostname.startsWith("127.")) ||
    hostname === "[::1]";
  const insecureBackend = backendUrl.protocol === "http:" && !loopback;
  if (insecureBackend && !allowInsecureBackend) {
    throw new Error(
      "The backend requires HTTPS outside loopback. Use --allow-insecure-backend only on a trusted internal network.",
    );
  }
  if (address === undefined) throw new Error("Missing web listen address.");
  return {
    publicOrigin,
    backendUrl,
    allowInsecureBackend,
    insecureBackend,
    address,
    logging: resolveLogging(raw.logging, cwd),
    printConfig: raw.printConfig,
    provenance: configurationProvenance({
      publicOrigin: raw.publicOrigin,
      backendUrl: raw.backendUrl,
      allowInsecureBackend: raw.allowInsecureBackend,
      webListen: raw.address,
      logLevel: raw.logging.level,
      logFormat: raw.logging.format,
      logOutput: raw.logging.output,
    }),
  };
}

export type WebOptions = ReturnType<typeof resolveWebOptions>;

/** Describe the web projection without reading backend database or mail settings.
 * @returns Effective public values, their sources and unused sections.
 */
export function describeWebConfiguration(options: WebOptions) {
  const { formatter } = options.logging.logOutput;
  const values = {
    logFormat:
      formatter === undefined ? "default" : textFormatter().format(formatter),
    publicOrigin: options.publicOrigin.origin,
    backendUrl: options.backendUrl.origin,
    allowInsecureBackend: options.allowInsecureBackend,
    webListen: options.address,
    logLevel: options.logging.logLevel,
    logOutput:
      options.logging.logOutput.type === "console"
        ? "-"
        : options.logging.logOutput.path,
  };
  return {
    command: "web",
    settings: Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        const setting = settings[key as keyof typeof settings];
        return [setting.toml, { value, ...options.provenance[key] }];
      }),
    ),
    ignored: configurationProjection("web").unusedAreas.map((area) => ({
      area,
      reason: "unused by this command",
    })),
  };
}
