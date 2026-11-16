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

import { getLogger } from "@logtape/logtape";
import { type MessageContent, type Receipt, createMessage } from "@upyo/core";

import type { UserContext } from "../builder.ts";

/** Send login mail without exposing non-cancellation provider failures. */
export async function sendMail(
  to: string,
  loginUrl: string,
  ctx: UserContext,
): Promise<void> {
  const signal = ctx.operationSignal ?? ctx.request.signal;
  if (signal.aborted) {
    throw new DOMException("Mail sending cancelled.", "AbortError");
  }
  try {
    const receipt = await ctx.mailer.send(
      createMessage({
        from: ctx.emailFrom,
        to,
        // FIXME: https://github.com/fedify-dev/drfed/issues/35
        subject: "Sign in to DrFed",
        content: renderLoginEmail(loginUrl),
      }),
      { signal },
    );
    if (signal.aborted) {
      throw new DOMException("Mail sending cancelled.", "AbortError");
    }
    logReceipt(receipt);
  } catch {
    if (signal.aborted) {
      throw new DOMException("Mail sending cancelled.", "AbortError");
    }
    logger.warn("Login mail delivery failed.", { outcome: "exception" });
  }
}

const renderLoginEmail = (loginUrl: string): MessageContent => ({
  // FIXME: https://github.com/fedify-dev/drfed/issues/35
  // oxlint-disable no-inline-comments
  text: `Hello, Welcome to DrFed! If you request to login to DrFed, please visit:

open ${loginUrl}${/* Split between the link and the last `\n` */ " "}

Otherwise, please just ignore this mail.`,
});
// oxlint-enable no-inline-comments

export function logReceipt(receipt: Receipt<string>): void {
  if (receipt.successful) {
    logger.debug("Login mail delivery succeeded.", { outcome: "sent" });
    return;
  }
  logger.warn("Login mail delivery failed.", { outcome: "failed" });
}

const logger = getLogger(["drfed", "graphql", "auth"]);
