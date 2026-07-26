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

import type { APIEvent } from "@solidjs/start/server";

// Note: setCookie(nativeEvent, ...) from @solidjs/start/http is intentionally
// NOT used here. In @solidjs/start 2.0.0-alpha.2, that function produces a
// malformed Set-Cookie header in both "use server" RPCs and POST API route
// handlers — the cookie name becomes "[METHOD] URL" instead of the intended
// name.
export async function POST({ request }: APIEvent) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(undefined, { status: 400 });
  }
  if (typeof body !== "object" || body == undefined) {
    return new Response(undefined, { status: 400 });
  }

  const accessToken =
    "accessToken" in body && typeof body.accessToken === "string"
      ? body.accessToken
      : undefined;
  const expiresValue =
    "expires" in body && typeof body.expires === "string"
      ? body.expires
      : undefined;

  // FIXME: Accesstoken validation
  if (accessToken == undefined || expiresValue == undefined) {
    return new Response(undefined, { status: 400 });
  }

  let expires: Temporal.Instant;

  try {
    expires = Temporal.Instant.from(expiresValue);
  } catch {
    return new Response(undefined, { status: 400 });
  }

  if (expires.epochNanoseconds <= Temporal.Now.instant().epochNanoseconds) {
    return new Response(undefined, { status: 400 });
  }

  const cookie = [
    `session=${encodeURIComponent(accessToken)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Expires=${new Date(expires.epochMilliseconds).toUTCString()}`,
    ...(new URL(request.url).protocol === "https:" ? ["Secure"] : []),
  ].join("; ");

  return new Response(undefined, {
    status: 204,
    headers: { "Set-Cookie": cookie },
  });
}
