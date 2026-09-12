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

export const sendMail = async (
  to: string,
  loginUrl: string,
  ctx: UserContext,
) =>
  await ctx.mailer.send(
    createMessage({
      from: ctx.emailFrom,
      to,
      // FIXME: Internationalize the email subject
      subject: "Sign in to DrFed",
      content: renderLoginEmail(loginUrl),
    }),
  );

const renderLoginEmail = (loginUrl: string): MessageContent => ({
  // FIXME: Internationalize the email content
  text: `Hello, Welcome to DrFed! If you request to login to DrFed, please visit:

open ${loginUrl}

Otherwise, please just ignore this mail.`,
});

export function logReceipt(receipt: Receipt<string>): void {
  if (receipt.successful) {
    logger.debug(`${receipt.messageId} sent successfully.`);
    return;
  }
  logger.warn(`Sending a mail failed: ${receipt.errorMessages.join("\n")}`);
}

const logger = getLogger(["drfed", "graphql", "auth"]);
