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

import { Template } from "@fedify/uri-template";
import { getLogger } from "@logtape/logtape";

import { VerifyUrlExpandingError } from "./errors.ts";

export interface ExpandVerifyUrlParams {
  template: Template | undefined | null;
  challengeId: `${string}-${string}-${string}-${string}-${string}`;
  code: string;
  loginOrigins: ReadonlySet<string>;
}

export default function expandVerifyUrl({
  template,
  challengeId,
  code,
  loginOrigins,
}: ExpandVerifyUrlParams): string | null {
  // Showing the errors occurring here to the user poses a security threat,
  // so they are handled as `null` and then processed as a fallback in
  // `expandVerifyUrl`.
  try {
    if (template == null) {
      return null;
    }
    const url = expandUrl(template, challengeId, code);
    assertAllow(url, loginOrigins);
    return url.toString();
  } catch (error) {
    // Almost of errors that can occur in this code could be
    logger.warn(`Error while expand verify URL: {error}`, { error });
    return null;
  }
}

function expandUrl(template: Template, challengeId: string, code: string) {
  const expanded = template.expand({ challengeId, code });
  if (!(expanded.includes(challengeId) && expanded.includes(code))) {
    throw new VerifyUrlExpandingError(
      // oxlint-disable-next-line prefer-template
      "`template` doesn't seem have `challengeId` or `code` variables. `template:`" +
        template,
    );
  }
  const url = URL.canParse(expanded)
    ? new URL(expanded)
    : new VerifyUrlExpandingError(
        `Unsupported verify URL scheme: ${template}.`,
      ).throw();
  return url;
}

const assertAllow = (url: URL, loginOrigins: ReadonlySet<string>) =>
  !loginOrigins.has(url.origin) &&
  new VerifyUrlExpandingError(
    `LoginOrigin not allowed for verify URL: ${url.origin}.`,
  ).throw();

const logger = getLogger(["drfed", "graphql", "expand"]);
