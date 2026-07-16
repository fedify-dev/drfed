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

import type { Database } from "@drfed/models";
import { getYogaLogger } from "@logtape/graphql-yoga";
import { getLogger } from "@logtape/logtape";
import type { Transport } from "@upyo/core";
import { MockTransport } from "@upyo/mock";
import {
  type YogaServerInstance,
  createYoga,
  useExecutionCancellation,
} from "graphql-yoga";

import { hashSecret } from "./auth/hash.ts";
import type { ServerContext, UserContext } from "./builder.ts";
import { schema } from "./schema.ts";

/**
 * Options for Yoga server.
 */
export interface YogaServerOptions {
  /**
   * Email sending services.
   */
  mailer?: Transport | undefined;

  /**
   * Email address to send.
   */
  emailFrom?: string;

  /**
   * Origin list.
   */
  origins?: ReadonlySet<string>;
}

/**
 * Creates a Yoga server instance with the provided schema and context.
 * @param {Database} db The database instance.
 * @param {YogaServerOptions} _options Options for server.
 * @returns A `YogaServerInstance` configured with the schema and context for
 *          handling GraphQL requests.
 */
export function createYogaServer(
  db: Database,
  _options: YogaServerOptions = {},
): YogaServerInstance<ServerContext, UserContext> {
  const options = fillOptions(_options);
  return createYoga({
    async context(ctx) {
      const anonymous = { db, request: ctx.request, ...options };
      const accessToken = getAccessToken(ctx.request.headers);
      if (accessToken == null) {
        return anonymous;
      }
      const authenticated = await findSession(accessToken, db);
      if (authenticated == null) {
        return anonymous;
      }
      const { account, ...session } = authenticated;
      return { ...anonymous, session, account };
    },
    plugins: [useExecutionCancellation()],
    schema,
    logging: getYogaLogger(),
  });
}

function mockTransport() {
  logger.warn(
    "Without `mailer` option, use default `MockTransport` as mailer. " +
      "With default `MockTransport`, you can't read any mails.",
  );
  return new MockTransport();
}

const fillOptions = (opt: YogaServerOptions): Required<YogaServerOptions> => ({
  mailer: opt?.mailer ?? mockTransport(),
  emailFrom: opt?.emailFrom ?? "noreply@drfed.org",
  origins: opt?.origins ?? new Set(["https://drfed.org"]),
});

const getAccessToken = (headers: Headers) =>
  /^Bearer (?<token>[^\s]+)$/u.exec(headers.get("Authorization") ?? "")?.groups
    ?.token ?? null;

const findSession = async (accessToken: string, db: Database) =>
  await db.query.sessions.findFirst({
    where: {
      tokenHash: await hashSecret(accessToken),
      expires: { gt: new Date(Temporal.Now.instant().toString()) },
    },
    with: { account: true },
  });

const logger = getLogger(["drfed", "graphql", "yoga"]);
