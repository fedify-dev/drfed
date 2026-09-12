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
import { GraphQLError } from "graphql";

export interface ExpandVerifyUrlParams {
  template: Template;
  challengeId: `${string}-${string}-${string}-${string}-${string}`;
  code: string;
  loginOrigins: ReadonlySet<string>;
}

export default function expandVerifyUrl({
  template,
  challengeId,
  code,
  loginOrigins,
}: ExpandVerifyUrlParams): string {
  assertVariable(template, "challengeId");
  assertVariable(template, "code");

  let url: URL;
  try {
    url = new URL(template.expand({ challengeId, code }));
  } catch {
    throw invalidVerifyUrl(
      "Verify URL template must expand to an absolute URL.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalidVerifyUrl("Verify URL must use HTTP or HTTPS.");
  }
  if (!loginOrigins.has(url.origin)) {
    throw invalidVerifyUrl(`Verify URL origin is not allowed: ${url.origin}.`);
  }
  return url.href;
}

function assertVariable(template: Template, name: string): void {
  const found = template.tokens.some(
    (token) =>
      token.kind === "expression" &&
      token.vars.some(
        (variable) => variable.name === name && variable.prefix == null,
      ),
  );
  if (!found) {
    throw invalidVerifyUrl(`Verify URL template must include {${name}}.`);
  }
}

const invalidVerifyUrl = (message: string) =>
  new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
