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

// oxlint-disable-next-line import/no-unassigned-import -- Environment marker.
import "server-only";
import { getRequestProtocol, setCookie } from "@solidjs/start/http";

const SESSION_COOKIE = "session";
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function setSessionCookie(
  accessToken: string,
  expiresValue: string,
): void {
  if (!ACCESS_TOKEN_PATTERN.test(accessToken)) {
    throw new TypeError("Invalid session access token.");
  }

  let expires: Temporal.Instant;
  try {
    expires = Temporal.Instant.from(expiresValue);
  } catch {
    throw new TypeError("Invalid session expiration.");
  }

  if (expires.epochNanoseconds <= Temporal.Now.instant().epochNanoseconds) {
    throw new TypeError("Session expiration must be in the future.");
  }

  setCookie(SESSION_COOKIE, accessToken, {
    expires: new Date(expires.epochMilliseconds),
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: getRequestProtocol() === "https",
  });
}
