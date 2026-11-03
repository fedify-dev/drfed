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

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { env as processEnv } from "node:process";

import {
  type ConfigMeta,
  bindConfig,
  createConfigContext,
} from "@optique/config";
import { message } from "@optique/core/message";
import { map } from "@optique/core/modifiers";
import type { Parser } from "@optique/core/parser";
import { type ValueParser, string, transform } from "@optique/core/valueparser";
import { bindEnv, bool, createEnvContext } from "@optique/env";
import { parse as parseToml } from "smol-toml";
import * as v from "valibot";

/** The source that supplied a setting, before runtime resources are created. */
export type ConfigurationSource = "cli" | "env" | "config" | "default";

/** A parsed value with its source, including the selected TOML file. */
export interface Sourced<T> {
  readonly value: T;
  readonly source: ConfigurationSource;
  readonly configPath?: string;
}

const text = v.string("Expected a string.");
const boolean = v.boolean("Expected a Boolean.");
const texts = v.array(text, "Expected an array of strings.");
const table = <T extends v.ObjectEntries>(entries: T) =>
  v.strictObject(entries, "Unknown setting or invalid table.");

/** Structural validation applies to every section, including unused ones. */
export const configurationSchema = table({
  server: v.optional(
    table({
      root_origin: v.optional(text),
      listen: v.optional(text),
      login_origins: v.optional(texts),
      web: v.optional(boolean),
    }),
  ),
  web: v.optional(
    table({
      public_origin: v.optional(text),
      listen: v.optional(text),
      backend_url: v.optional(text),
      allow_insecure_backend: v.optional(boolean),
    }),
  ),
  database: v.optional(
    table({
      data_path: v.optional(text),
      url: v.optional(text),
      migrate: v.optional(boolean),
      lock_timeout_ms: v.optional(v.number("Expected a number.")),
    }),
  ),
  telemetry: v.optional(
    table({
      log_level: v.optional(text),
      log_format: v.optional(text),
      log_output: v.optional(text),
    }),
  ),
  mail: v.optional(
    table({
      from: v.optional(text),
      transport: v.optional(text),
      api_key: v.optional(text),
      api_key_file: v.optional(text),
      plunk: v.optional(
        table({
          api_key: v.optional(text),
          api_key_file: v.optional(text),
          base_url: v.optional(text),
          timeout_ms: v.optional(v.number("Expected a number.")),
        }),
      ),
      resend: v.optional(
        table({
          api_key: v.optional(text),
          api_key_file: v.optional(text),
          base_url: v.optional(text),
          timeout_ms: v.optional(v.number("Expected a number.")),
          retries: v.optional(v.number("Expected a number.")),
        }),
      ),
      ses: v.optional(
        table({
          auth: v.optional(text),
          access_key_id: v.optional(text),
          access_key_id_file: v.optional(text),
          secret_access_key: v.optional(text),
          secret_access_key_file: v.optional(text),
          session_token: v.optional(text),
          session_token_file: v.optional(text),
          region: v.optional(text),
          timeout_ms: v.optional(v.number("Expected a number.")),
        }),
      ),
      sendgrid: v.optional(
        table({
          api_key: v.optional(text),
          api_key_file: v.optional(text),
          base_url: v.optional(text),
          timeout_ms: v.optional(v.number("Expected a number.")),
        }),
      ),
      mailgun: v.optional(
        table({
          api_key: v.optional(text),
          api_key_file: v.optional(text),
          domain: v.optional(text),
          region: v.optional(text),
          base_url: v.optional(text),
          timeout_ms: v.optional(v.number("Expected a number.")),
        }),
      ),
      mailtrap: v.optional(
        table({
          api_token: v.optional(text),
          api_token_file: v.optional(text),
          sandbox: v.optional(boolean),
          inbox_id: v.optional(text),
          send_base_url: v.optional(text),
          sandbox_base_url: v.optional(text),
          timeout_ms: v.optional(v.number("Expected a number.")),
        }),
      ),
      maileroo: v.optional(
        table({
          api_key: v.optional(text),
          api_key_file: v.optional(text),
          base_url: v.optional(text),
          timeout_ms: v.optional(v.number("Expected a number.")),
        }),
      ),
      lettermint: v.optional(
        table({
          api_token: v.optional(text),
          api_token_file: v.optional(text),
          base_url: v.optional(text),
          route: v.optional(text),
          timeout_ms: v.optional(v.number("Expected a number.")),
          retries: v.optional(v.number("Expected a number.")),
        }),
      ),
      jmap: v.optional(
        table({
          session_url: v.optional(text),
          bearer_token: v.optional(text),
          bearer_token_file: v.optional(text),
          user: v.optional(text),
          password: v.optional(text),
          password_file: v.optional(text),
          account_id: v.optional(text),
          identity_id: v.optional(text),
          base_url: v.optional(text),
          timeout_ms: v.optional(v.number("Expected a number.")),
          session_cache_ttl_ms: v.optional(v.number("Expected a number.")),
        }),
      ),
      smtp: v.optional(
        table({
          url: v.optional(text),
          host: v.optional(text),
          port: v.optional(v.number("Expected a number.")),
          tls: v.optional(text),
          user: v.optional(text),
          password: v.optional(text),
          password_file: v.optional(text),
          auth_method: v.optional(text),
          access_token: v.optional(text),
          access_token_file: v.optional(text),
          connection_timeout_ms: v.optional(v.number("Expected a number.")),
          socket_timeout_ms: v.optional(v.number("Expected a number.")),
          pool_size: v.optional(v.number("Expected a number.")),
          local_name: v.optional(text),
          ca_file: v.optional(text),
          cert_file: v.optional(text),
          key_file: v.optional(text),
        }),
      ),
      log_content: v.optional(boolean),
    }),
  ),
});

export type ConfigurationFile = v.InferOutput<typeof configurationSchema>;
export type ConfigurationArea = keyof ConfigurationFile;
export type ConfigurationCommand = "server" | "web" | "migrate" | "account";

/** Shared metadata used by bindings and, later, command documentation. */
export interface ConfigurationSetting<T> {
  readonly toml: string;
  readonly env: string;
  readonly secret: boolean;
  readonly commands: readonly ConfigurationCommand[];
  readonly description: string;
  readonly read: (config: ConfigurationFile) => T | undefined;
}

function setting<T>(
  toml: string,
  env: string,
  commands: readonly ConfigurationCommand[],
  description: string,
  read: (config: ConfigurationFile) => T | undefined,
  secret = false,
): ConfigurationSetting<T> {
  return { toml, env, commands, description, read, secret };
}

/** One registry shared by all DrFed command projections. */
export const configurationSettings = {
  logLevel: setting(
    "telemetry.log_level",
    "LOG_LEVEL",
    ["server", "web"],
    "Log level",
    (config) => config.telemetry?.log_level,
  ),
  logFormat: setting(
    "telemetry.log_format",
    "LOG_FORMAT",
    ["server", "web"],
    "Log formatter",
    (config) => config.telemetry?.log_format,
  ),
  logOutput: setting(
    "telemetry.log_output",
    "LOG_OUTPUT",
    ["server", "web"],
    "Log output file",
    (config) => config.telemetry?.log_output,
  ),
  rootOrigin: setting(
    "server.root_origin",
    "ROOT_ORIGIN",
    ["server"],
    "Root origin",
    (config) => config.server?.root_origin,
  ),
  listen: setting(
    "server.listen",
    "LISTEN",
    ["server"],
    "Server listen address",
    (config) => config.server?.listen,
  ),
  loginOrigins: setting(
    "server.login_origins",
    "LOGIN_ORIGINS",
    ["server"],
    "Allowed login origins",
    (config) => config.server?.login_origins,
  ),
  web: setting(
    "server.web",
    "WEB",
    ["server"],
    "Serve the web frontend",
    (config) => config.server?.web,
  ),
  publicOrigin: setting(
    "web.public_origin",
    "PUBLIC_ORIGIN",
    ["server", "web"],
    "Public web origin",
    (config) => config.web?.public_origin,
  ),
  webListen: setting(
    "web.listen",
    "WEB_LISTEN",
    ["web"],
    "Web listen address",
    (config) => config.web?.listen,
  ),
  backendUrl: setting(
    "web.backend_url",
    "BACKEND_URL",
    ["web"],
    "Backend URL",
    (config) => config.web?.backend_url,
  ),
  allowInsecureBackend: setting(
    "web.allow_insecure_backend",
    "ALLOW_INSECURE_BACKEND",
    ["web"],
    "Allow an insecure HTTP backend",
    (config) => config.web?.allow_insecure_backend,
  ),
  dataPath: setting(
    "database.data_path",
    "DATA_PATH",
    ["server", "migrate", "account"],
    "PGlite data directory",
    (config) => config.database?.data_path,
  ),
  postgresUrl: setting(
    "database.url",
    "POSTGRES_URL",
    ["server", "migrate", "account"],
    "PostgreSQL connection URL",
    (config) => config.database?.url,
    true,
  ),
  migrate: setting(
    "database.migrate",
    "MIGRATE",
    ["server"],
    "Apply migrations at startup",
    (config) => config.database?.migrate,
  ),
  migrationLockTimeout: setting(
    "database.lock_timeout_ms",
    "MIGRATION_LOCK_TIMEOUT",
    ["server", "migrate", "account"],
    "Migration lock wait limit in milliseconds",
    (config) => config.database?.lock_timeout_ms,
  ),
  emailFrom: setting(
    "mail.from",
    "EMAIL_FROM",
    ["server"],
    "Login mail sender",
    (config) => config.mail?.from,
  ),
  mailTransport: setting(
    "mail.transport",
    "MAIL_TRANSPORT",
    ["server"],
    "Mail transport",
    (config) => config.mail?.transport,
  ),
  mailApiKey: setting(
    "mail.api_key",
    "MAIL_API_KEY",
    ["server"],
    "API service credential for the selected mail transport",
    (config) => config.mail?.api_key,
    true,
  ),
  mailApiKeyFile: setting(
    "mail.api_key_file",
    "MAIL_API_KEY_FILE",
    ["server"],
    "File containing the selected mail API service credential",
    (config) => config.mail?.api_key_file,
    true,
  ),
  plunkApiKey: setting(
    "mail.plunk.api_key",
    "PLUNK_API_KEY",
    ["server"],
    "Plunk sending API key",
    (config) => config.mail?.plunk?.api_key,
    true,
  ),
  plunkApiKeyFile: setting(
    "mail.plunk.api_key_file",
    "PLUNK_API_KEY_FILE",
    ["server"],
    "File containing the Plunk API key",
    (config) => config.mail?.plunk?.api_key_file,
    true,
  ),
  plunkBaseUrl: setting(
    "mail.plunk.base_url",
    "PLUNK_BASE_URL",
    ["server"],
    "Plunk API base URL including a self-hosted path",
    (config) => config.mail?.plunk?.base_url,
    false,
  ),
  plunkTimeout: setting(
    "mail.plunk.timeout_ms",
    "PLUNK_TIMEOUT",
    ["server"],
    "Whole Plunk delivery timeout in milliseconds",
    (config) => config.mail?.plunk?.timeout_ms,
    false,
  ),
  resendApiKey: setting(
    "mail.resend.api_key",
    "RESEND_API_KEY",
    ["server"],
    "Resend sending API key",
    (config) => config.mail?.resend?.api_key,
    true,
  ),
  resendApiKeyFile: setting(
    "mail.resend.api_key_file",
    "RESEND_API_KEY_FILE",
    ["server"],
    "File containing the Resend API key",
    (config) => config.mail?.resend?.api_key_file,
    true,
  ),
  resendBaseUrl: setting(
    "mail.resend.base_url",
    "RESEND_BASE_URL",
    ["server"],
    "Resend API base URL including an API path",
    (config) => config.mail?.resend?.base_url,
    false,
  ),
  resendTimeout: setting(
    "mail.resend.timeout_ms",
    "RESEND_TIMEOUT",
    ["server"],
    "Whole Resend delivery timeout in milliseconds",
    (config) => config.mail?.resend?.timeout_ms,
    false,
  ),
  resendRetries: setting(
    "mail.resend.retries",
    "RESEND_RETRIES",
    ["server"],
    "Resend retries using one idempotency key (0 through 10)",
    (config) => config.mail?.resend?.retries,
    false,
  ),
  sesAuth: setting(
    "mail.ses.auth",
    "SES_AUTH",
    ["server"],
    "SES authentication mode (credentials or session)",
    (config) => config.mail?.ses?.auth,
    false,
  ),
  sesAccessKeyId: setting(
    "mail.ses.access_key_id",
    "SES_ACCESS_KEY_ID",
    ["server"],
    "SES access key ID",
    (config) => config.mail?.ses?.access_key_id,
    true,
  ),
  sesAccessKeyIdFile: setting(
    "mail.ses.access_key_id_file",
    "SES_ACCESS_KEY_ID_FILE",
    ["server"],
    "File containing the SES access key ID",
    (config) => config.mail?.ses?.access_key_id_file,
    true,
  ),
  sesSecretAccessKey: setting(
    "mail.ses.secret_access_key",
    "SES_SECRET_ACCESS_KEY",
    ["server"],
    "SES secret access key",
    (config) => config.mail?.ses?.secret_access_key,
    true,
  ),
  sesSecretAccessKeyFile: setting(
    "mail.ses.secret_access_key_file",
    "SES_SECRET_ACCESS_KEY_FILE",
    ["server"],
    "File containing the SES secret access key",
    (config) => config.mail?.ses?.secret_access_key_file,
    true,
  ),
  sesSessionToken: setting(
    "mail.ses.session_token",
    "SES_SESSION_TOKEN",
    ["server"],
    "SES temporary session token",
    (config) => config.mail?.ses?.session_token,
    true,
  ),
  sesSessionTokenFile: setting(
    "mail.ses.session_token_file",
    "SES_SESSION_TOKEN_FILE",
    ["server"],
    "File containing the SES session token",
    (config) => config.mail?.ses?.session_token_file,
    true,
  ),
  sesRegion: setting(
    "mail.ses.region",
    "SES_REGION",
    ["server"],
    "SES AWS region",
    (config) => config.mail?.ses?.region,
    false,
  ),
  sesTimeout: setting(
    "mail.ses.timeout_ms",
    "SES_TIMEOUT",
    ["server"],
    "Whole SES delivery timeout in milliseconds",
    (config) => config.mail?.ses?.timeout_ms,
    false,
  ),
  sendgridApiKey: setting(
    "mail.sendgrid.api_key",
    "SENDGRID_API_KEY",
    ["server"],
    "SendGrid sending API key",
    (config) => config.mail?.sendgrid?.api_key,
    true,
  ),
  sendgridApiKeyFile: setting(
    "mail.sendgrid.api_key_file",
    "SENDGRID_API_KEY_FILE",
    ["server"],
    "File containing the SendGrid API key",
    (config) => config.mail?.sendgrid?.api_key_file,
    true,
  ),
  sendgridBaseUrl: setting(
    "mail.sendgrid.base_url",
    "SENDGRID_BASE_URL",
    ["server"],
    "SendGrid API base URL including an API path",
    (config) => config.mail?.sendgrid?.base_url,
    false,
  ),
  sendgridTimeout: setting(
    "mail.sendgrid.timeout_ms",
    "SENDGRID_TIMEOUT",
    ["server"],
    "Whole SendGrid delivery timeout in milliseconds",
    (config) => config.mail?.sendgrid?.timeout_ms,
    false,
  ),
  mailgunApiKey: setting(
    "mail.mailgun.api_key",
    "MAILGUN_API_KEY",
    ["server"],
    "Mailgun sending API key",
    (config) => config.mail?.mailgun?.api_key,
    true,
  ),
  mailgunApiKeyFile: setting(
    "mail.mailgun.api_key_file",
    "MAILGUN_API_KEY_FILE",
    ["server"],
    "File containing the Mailgun API key",
    (config) => config.mail?.mailgun?.api_key_file,
    true,
  ),
  mailgunDomain: setting(
    "mail.mailgun.domain",
    "MAILGUN_DOMAIN",
    ["server"],
    "Verified Mailgun sending domain",
    (config) => config.mail?.mailgun?.domain,
    false,
  ),
  mailgunRegion: setting(
    "mail.mailgun.region",
    "MAILGUN_REGION",
    ["server"],
    "Mailgun API region (us or eu)",
    (config) => config.mail?.mailgun?.region,
    false,
  ),
  mailgunBaseUrl: setting(
    "mail.mailgun.base_url",
    "MAILGUN_BASE_URL",
    ["server"],
    "Mailgun API base URL including its path",
    (config) => config.mail?.mailgun?.base_url,
    false,
  ),
  mailgunTimeout: setting(
    "mail.mailgun.timeout_ms",
    "MAILGUN_TIMEOUT",
    ["server"],
    "Whole Mailgun delivery timeout in milliseconds",
    (config) => config.mail?.mailgun?.timeout_ms,
    false,
  ),
  mailtrapApiToken: setting(
    "mail.mailtrap.api_token",
    "MAILTRAP_API_TOKEN",
    ["server"],
    "Mailtrap sending API token",
    (config) => config.mail?.mailtrap?.api_token,
    true,
  ),
  mailtrapApiTokenFile: setting(
    "mail.mailtrap.api_token_file",
    "MAILTRAP_API_TOKEN_FILE",
    ["server"],
    "File containing the Mailtrap API token",
    (config) => config.mail?.mailtrap?.api_token_file,
    true,
  ),
  mailtrapSandbox: setting(
    "mail.mailtrap.sandbox",
    "MAILTRAP_SANDBOX",
    ["server"],
    "Capture messages in a Mailtrap test inbox",
    (config) => config.mail?.mailtrap?.sandbox,
    false,
  ),
  mailtrapInboxId: setting(
    "mail.mailtrap.inbox_id",
    "MAILTRAP_INBOX_ID",
    ["server"],
    "Mailtrap sandbox inbox ID",
    (config) => config.mail?.mailtrap?.inbox_id,
    false,
  ),
  mailtrapSendBaseUrl: setting(
    "mail.mailtrap.send_base_url",
    "MAILTRAP_SEND_BASE_URL",
    ["server"],
    "Mailtrap sending API base URL",
    (config) => config.mail?.mailtrap?.send_base_url,
    false,
  ),
  mailtrapSandboxBaseUrl: setting(
    "mail.mailtrap.sandbox_base_url",
    "MAILTRAP_SANDBOX_BASE_URL",
    ["server"],
    "Mailtrap sandbox API base URL",
    (config) => config.mail?.mailtrap?.sandbox_base_url,
    false,
  ),
  mailtrapTimeout: setting(
    "mail.mailtrap.timeout_ms",
    "MAILTRAP_TIMEOUT",
    ["server"],
    "Whole Mailtrap delivery timeout in milliseconds",
    (config) => config.mail?.mailtrap?.timeout_ms,
    false,
  ),
  mailerooApiKey: setting(
    "mail.maileroo.api_key",
    "MAILEROO_API_KEY",
    ["server"],
    "Maileroo API sending key",
    (config) => config.mail?.maileroo?.api_key,
    true,
  ),
  mailerooApiKeyFile: setting(
    "mail.maileroo.api_key_file",
    "MAILEROO_API_KEY_FILE",
    ["server"],
    "Maileroo File containing the API sending key",
    (config) => config.mail?.maileroo?.api_key_file,
    true,
  ),
  mailerooBaseUrl: setting(
    "mail.maileroo.base_url",
    "MAILEROO_BASE_URL",
    ["server"],
    "Maileroo API base URL including its path",
    (config) => config.mail?.maileroo?.base_url,
    false,
  ),
  mailerooTimeout: setting(
    "mail.maileroo.timeout_ms",
    "MAILEROO_TIMEOUT",
    ["server"],
    "Maileroo Whole delivery timeout in milliseconds",
    (config) => config.mail?.maileroo?.timeout_ms,
    false,
  ),
  lettermintApiToken: setting(
    "mail.lettermint.api_token",
    "LETTERMINT_API_TOKEN",
    ["server"],
    "Lettermint sending API token",
    (config) => config.mail?.lettermint?.api_token,
    true,
  ),
  lettermintApiTokenFile: setting(
    "mail.lettermint.api_token_file",
    "LETTERMINT_API_TOKEN_FILE",
    ["server"],
    "File containing the Lettermint API token",
    (config) => config.mail?.lettermint?.api_token_file,
    true,
  ),
  lettermintBaseUrl: setting(
    "mail.lettermint.base_url",
    "LETTERMINT_BASE_URL",
    ["server"],
    "Lettermint API base origin",
    (config) => config.mail?.lettermint?.base_url,
    false,
  ),
  lettermintRoute: setting(
    "mail.lettermint.route",
    "LETTERMINT_ROUTE",
    ["server"],
    "Lettermint delivery route",
    (config) => config.mail?.lettermint?.route,
    false,
  ),
  lettermintTimeout: setting(
    "mail.lettermint.timeout_ms",
    "LETTERMINT_TIMEOUT",
    ["server"],
    "Whole Lettermint delivery timeout in milliseconds",
    (config) => config.mail?.lettermint?.timeout_ms,
    false,
  ),
  lettermintRetries: setting(
    "mail.lettermint.retries",
    "LETTERMINT_RETRIES",
    ["server"],
    "Lettermint API retries using one idempotency key (0 through 10)",
    (config) => config.mail?.lettermint?.retries,
    false,
  ),
  jmapSessionUrl: setting(
    "mail.jmap.session_url",
    "JMAP_SESSION_URL",
    ["server"],
    "JMAP session discovery URL",
    (config) => config.mail?.jmap?.session_url,
    false,
  ),
  jmapBearerToken: setting(
    "mail.jmap.bearer_token",
    "JMAP_BEARER_TOKEN",
    ["server"],
    "JMAP bearer token",
    (config) => config.mail?.jmap?.bearer_token,
    true,
  ),
  jmapBearerTokenFile: setting(
    "mail.jmap.bearer_token_file",
    "JMAP_BEARER_TOKEN_FILE",
    ["server"],
    "File containing the JMAP bearer token",
    (config) => config.mail?.jmap?.bearer_token_file,
    true,
  ),
  jmapUser: setting(
    "mail.jmap.user",
    "JMAP_USER",
    ["server"],
    "JMAP basic authentication username",
    (config) => config.mail?.jmap?.user,
    true,
  ),
  jmapPassword: setting(
    "mail.jmap.password",
    "JMAP_PASSWORD",
    ["server"],
    "JMAP basic authentication password",
    (config) => config.mail?.jmap?.password,
    true,
  ),
  jmapPasswordFile: setting(
    "mail.jmap.password_file",
    "JMAP_PASSWORD_FILE",
    ["server"],
    "File containing the JMAP password",
    (config) => config.mail?.jmap?.password_file,
    true,
  ),
  jmapAccountId: setting(
    "mail.jmap.account_id",
    "JMAP_ACCOUNT_ID",
    ["server"],
    "JMAP account ID; automatically discovered when absent",
    (config) => config.mail?.jmap?.account_id,
    false,
  ),
  jmapIdentityId: setting(
    "mail.jmap.identity_id",
    "JMAP_IDENTITY_ID",
    ["server"],
    "JMAP sender identity ID; automatically discovered when absent",
    (config) => config.mail?.jmap?.identity_id,
    false,
  ),
  jmapBaseUrl: setting(
    "mail.jmap.base_url",
    "JMAP_BASE_URL",
    ["server"],
    "JMAP base origin for rewriting discovered endpoints",
    (config) => config.mail?.jmap?.base_url,
    false,
  ),
  jmapTimeout: setting(
    "mail.jmap.timeout_ms",
    "JMAP_TIMEOUT",
    ["server"],
    "JMAP HTTP request timeout in milliseconds",
    (config) => config.mail?.jmap?.timeout_ms,
    false,
  ),
  jmapSessionCacheTtl: setting(
    "mail.jmap.session_cache_ttl_ms",
    "JMAP_SESSION_CACHE_TTL",
    ["server"],
    "JMAP session cache lifetime in milliseconds",
    (config) => config.mail?.jmap?.session_cache_ttl_ms,
    false,
  ),
  smtpUrl: setting(
    "mail.smtp.url",
    "SMTP_URL",
    ["server"],
    "SMTP connection URL",
    (config) => config.mail?.smtp?.url,
    true,
  ),
  mailLogContent: setting(
    "mail.log_content",
    "MAIL_LOG_CONTENT",
    ["server"],
    "Include mail subject and body in log-only output",
    (config) => config.mail?.log_content,
  ),
  smtpHost: setting(
    "mail.smtp.host",
    "SMTP_HOST",
    ["server"],
    "SMTP server hostname",
    (config) => config.mail?.smtp?.host,
    false,
  ),
  smtpPort: setting(
    "mail.smtp.port",
    "SMTP_PORT",
    ["server"],
    "SMTP server port",
    (config) => config.mail?.smtp?.port,
    false,
  ),
  smtpTls: setting(
    "mail.smtp.tls",
    "SMTP_TLS",
    ["server"],
    "SMTP TLS mode: direct, starttls-required or opportunistic",
    (config) => config.mail?.smtp?.tls,
    false,
  ),
  smtpUser: setting(
    "mail.smtp.user",
    "SMTP_USER",
    ["server"],
    "SMTP authentication username",
    (config) => config.mail?.smtp?.user,
    true,
  ),
  smtpPassword: setting(
    "mail.smtp.password",
    "SMTP_PASSWORD",
    ["server"],
    "SMTP authentication password",
    (config) => config.mail?.smtp?.password,
    true,
  ),
  smtpPasswordFile: setting(
    "mail.smtp.password_file",
    "SMTP_PASSWORD_FILE",
    ["server"],
    "File containing the SMTP password",
    (config) => config.mail?.smtp?.password_file,
    true,
  ),
  smtpAuthMethod: setting(
    "mail.smtp.auth_method",
    "SMTP_AUTH_METHOD",
    ["server"],
    "SMTP authentication method",
    (config) => config.mail?.smtp?.auth_method,
    false,
  ),
  smtpAccessToken: setting(
    "mail.smtp.access_token",
    "SMTP_ACCESS_TOKEN",
    ["server"],
    "Static SMTP OAuth access token",
    (config) => config.mail?.smtp?.access_token,
    true,
  ),
  smtpAccessTokenFile: setting(
    "mail.smtp.access_token_file",
    "SMTP_ACCESS_TOKEN_FILE",
    ["server"],
    "File containing the SMTP OAuth access token",
    (config) => config.mail?.smtp?.access_token_file,
    true,
  ),
  smtpConnectionTimeout: setting(
    "mail.smtp.connection_timeout_ms",
    "SMTP_CONNECTION_TIMEOUT",
    ["server"],
    "SMTP connection timeout in milliseconds",
    (config) => config.mail?.smtp?.connection_timeout_ms,
    false,
  ),
  smtpSocketTimeout: setting(
    "mail.smtp.socket_timeout_ms",
    "SMTP_SOCKET_TIMEOUT",
    ["server"],
    "SMTP socket timeout in milliseconds",
    (config) => config.mail?.smtp?.socket_timeout_ms,
    false,
  ),
  smtpPoolSize: setting(
    "mail.smtp.pool_size",
    "SMTP_POOL_SIZE",
    ["server"],
    "Maximum owned SMTP connections",
    (config) => config.mail?.smtp?.pool_size,
    false,
  ),
  smtpLocalName: setting(
    "mail.smtp.local_name",
    "SMTP_LOCAL_NAME",
    ["server"],
    "Local name for SMTP EHLO",
    (config) => config.mail?.smtp?.local_name,
    false,
  ),
  smtpCaFile: setting(
    "mail.smtp.ca_file",
    "SMTP_CA_FILE",
    ["server"],
    "File containing additional SMTP certificate authorities",
    (config) => config.mail?.smtp?.ca_file,
    true,
  ),
  smtpCertFile: setting(
    "mail.smtp.cert_file",
    "SMTP_CERT_FILE",
    ["server"],
    "File containing the SMTP client certificate",
    (config) => config.mail?.smtp?.cert_file,
    true,
  ),
  smtpKeyFile: setting(
    "mail.smtp.key_file",
    "SMTP_KEY_FILE",
    ["server"],
    "File containing the SMTP client private key",
    (config) => config.mail?.smtp?.key_file,
    true,
  ),
} as const;

/** Metadata selected for one command or mode, without reading setting values. */
export interface ConfigurationProjection {
  readonly settings: readonly ConfigurationSetting<unknown>[];
  readonly areas: readonly ConfigurationArea[];
  readonly unusedAreas: readonly ConfigurationArea[];
}

/**
 * List shared settings consumed by a command, without reading their values.
 * @returns Selected definitions and consumed/unused configuration areas.
 */
export function configurationProjection(
  command: ConfigurationCommand,
  excludedAreas: readonly ConfigurationArea[] = [],
): ConfigurationProjection {
  const settings = Object.values(configurationSettings).filter(
    (entry) =>
      entry.commands.includes(command) &&
      !excludedAreas.includes(entry.toml.split(".")[0] as ConfigurationArea),
  );
  const areas = new Set(
    settings.map((entry) => entry.toml.split(".")[0] as ConfigurationArea),
  );
  return {
    settings,
    areas: [...areas],
    unusedAreas: (
      ["server", "web", "database", "mail", "telemetry"] as const
    ).filter((area) => !areas.has(area)),
  };
}

/**
 * Parse TOML without including its contents or secret values in errors.
 * @returns Structurally valid settings; unused domains remain unparsed.
 */
export function decodeConfiguration(contents: string): ConfigurationFile {
  let raw: unknown;
  try {
    raw = parseToml(contents, { unsafeKeyBehaviour: "throw" });
  } catch {
    throw new Error("Invalid TOML configuration.");
  }
  const parsed = v.safeParse(configurationSchema, raw);
  if (!parsed.success) {
    const paths = parsed.issues.map(
      (issue) =>
        issue.path?.map((item) => String(item.key)).join(".") ??
        "configuration",
    );
    throw new Error(`Invalid configuration structure at ${paths.join(", ")}.`);
  }
  return parsed.output;
}

/**
 * Resolve a path using its own source directory.
 * @returns An absolute path.
 */
export function configurationPath(
  value: Sourced<string | undefined>,
  cwd = process.cwd(),
): string {
  if (value.value === undefined) {
    throw new Error("No path setting was supplied.");
  }
  return resolve(
    value.configPath == null ? cwd : dirname(value.configPath),
    value.value,
  );
}

/**
 * Extract provenance without copying values, including credentials.
 * @returns Source metadata keyed by the provided setting names.
 */
export function configurationProvenance(
  values: Readonly<Record<string, Sourced<unknown> | undefined>>,
) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(
        (entry): entry is [string, Sourced<unknown>] =>
          entry[1] !== undefined && entry[1].value !== undefined,
      )
      .map(([key, value]) => [
        key,
        {
          source: value.source,
          ...(value.configPath === undefined
            ? {}
            : { configPath: value.configPath }),
        },
      ]),
  );
}

/**
 * A default computed when a parse or help output first needs it, so that
 * building a parser or completing a command reads nothing.
 */
export interface LazyDefault<T> {
  readonly lazy: () => T;
}

/**
 * Defer a default value until it is used.
 * @param compute Computes the default; called at most once.
 * @returns A default that {@link createConfigurationBindings}' `bind` accepts.
 */
export function lazyDefault<T>(compute: () => T): LazyDefault<T> {
  let computed: { readonly value: T } | undefined;
  return {
    lazy: () => (computed ??= { value: compute() }).value,
  };
}

function isLazyDefault<T>(value: T | LazyDefault<T>): value is LazyDefault<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "lazy" in value &&
    typeof value.lazy === "function"
  );
}

/**
 * Create independent contexts for one parse. Environment lookup remains lazy;
 * only the fields bound by the command are consumed. No .env file is loaded.
 * @returns Bindings, independent contexts, and a strict explicit-file loader.
 */
export function createConfigurationBindings(
  options: {
    readonly env?: (name: string) => string | undefined;
    readonly cwd?: string;
  } = {},
) {
  const cwd = options.cwd ?? process.cwd();
  const envContext = createEnvContext({
    prefix: "DRFED_",
    ...(options.env === undefined ? {} : { source: options.env }),
  });
  const configContext = createConfigContext({ schema: configurationSchema });

  function bind<T, TState, TRaw>(
    cli: Parser<"sync", T, TState>,
    definition: ConfigurationSetting<TRaw>,
    valueParser: ValueParser<"sync", T>,
    encode: (value: TRaw) => string,
    fallback?: T | LazyDefault<T>,
  ) {
    const defaultValue = (): T | undefined =>
      fallback !== undefined && isLazyDefault(fallback)
        ? fallback.lazy()
        : fallback;
    // Map the whole CLI parser. Mapping its value parser instead loses the
    // source tag when Optique re-validates an env/config fallback as CLI data.
    const tagged = map(
      cli,
      (value): Sourced<T | undefined> => ({ value, source: "cli" }),
    );
    // This adapter changes only our fresh mapped parser, not the caller's
    // parser or its value parser. Parsing and completion both carry errors.
    if (definition.secret) {
      const parseCli = tagged.parse.bind(tagged);
      tagged.parse = (context) => {
        const result = parseCli(context);
        return result.success
          ? result
          : { ...result, error: message`Invalid setting ${definition.toml}.` };
      };
      const completeCli = tagged.complete.bind(tagged);
      tagged.complete = (state, exec) => {
        const result = completeCli(state, exec);
        return result.success
          ? result
          : { ...result, error: message`Invalid setting ${definition.toml}.` };
      };
    }
    // Map() cannot infer how to turn a tagged default back into a CLI value.
    // Supply it explicitly; secret defaults never appear in help output.
    tagged.getDocFragments = (state) =>
      cli.getDocFragments(
        state,
        definition.secret ? undefined : defaultValue(),
      );
    const envValueParser: ValueParser<"sync", T> = {
      ...valueParser,
      parse(input) {
        const parsed = valueParser.parse(input);
        return !parsed.success && definition.secret
          ? {
              success: false,
              error: message`Invalid setting ${definition.toml}.`,
            }
          : parsed;
      },
    };
    const bound = bindEnv(
      bindConfig(tagged, {
        context: configContext,
        key: (config, meta): Sourced<T | undefined> | undefined => {
          const value = definition.read(config);
          if (value === undefined) return undefined;
          const parsed = valueParser.parse(encode(value));
          if (!parsed.success) {
            throw new Error(`Invalid setting ${definition.toml}.`);
          }
          return {
            value: parsed.value,
            source: "config",
            ...(meta == null ? {} : { configPath: meta.configPath }),
          };
        },
        // An object sentinel keeps absence distinct from a binding failure.
        // optional(bindEnv(...)) would swallow an invalid environment value.
        // The getter keeps a lazy default unread until a parse resolves it.
        default: {
          get value() {
            return defaultValue();
          },
          source: "default" as const,
        },
      }),
      {
        context: envContext,
        key: definition.env,
        parser: transform(envValueParser, {
          map: (value): Sourced<T | undefined> => ({ value, source: "env" }),
          unmap: (value) => {
            if (value.value === undefined) {
              throw new TypeError("Cannot format an absent setting.");
            }
            return value.value;
          },
        }),
      },
    );
    return bound;
  }

  const configPathParser = transform(string({ metavar: "FILE" }), {
    map: (value): Sourced<string> => ({
      value: resolve(cwd, value),
      source: "env",
    }),
    unmap: (value) => value.value,
  });

  function bindConfigPath<TState>(cli: Parser<"sync", string, TState>) {
    return bindEnv(
      map(
        cli,
        (value): Sourced<string> => ({
          value: resolve(cwd, value),
          source: "cli",
        }),
      ),
      {
        context: envContext,
        key: "CONFIG",
        parser: configPathParser,
      },
    );
  }

  async function load(parsed: {
    readonly configPath?: Sourced<string> | undefined;
  }): Promise<{ config: ConfigurationFile; meta: ConfigMeta } | undefined> {
    if (parsed.configPath === undefined) return undefined;
    const configPath = parsed.configPath.value;
    let contents: string;
    try {
      contents = await readFile(configPath, "utf8");
    } catch {
      throw new Error(`Cannot read configuration file ${configPath}.`);
    }
    return {
      config: decodeConfiguration(contents),
      meta: { configPath, configDir: dirname(configPath) },
    };
  }

  return {
    bind,
    bindConfigPath,
    load,
    contexts: [envContext, configContext] as const,
    // The environment lookup the bindings read, for non-setting markers.
    env: options.env ?? ((name: string) => processEnv[name]),
  };
}

/**
 * Value parser for JSON string arrays, including the empty array.
 * @returns A synchronous value parser.
 */
export function stringArray(): ValueParser<"sync", string[]> {
  return {
    mode: "sync",
    metavar: "JSON_ARRAY",
    placeholder: [],
    parse(input) {
      let value: unknown;
      try {
        value = JSON.parse(input);
      } catch {
        return {
          success: false,
          error: message`Expected a JSON string array.`,
        };
      }
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === "string")
      ) {
        return {
          success: false,
          error: message`Expected a JSON string array.`,
        };
      }
      return { success: true, value };
    },
    format: JSON.stringify,
  };
}

/** Environment and TOML Boolean spelling, shared with Optique. */
export const configurationBoolean = bool;
