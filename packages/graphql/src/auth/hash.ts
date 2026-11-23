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
// oxlint-disable func-names func-style id-length

export const hashSecret = async (raw: string): Promise<string> =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(raw)),
  ).toHex();

const textEncoder = new TextEncoder();

const ACCESS_TOKEN_BYTES = 32;

export const generateAccessToken = (): string =>
  crypto.getRandomValues(new Uint8Array(ACCESS_TOKEN_BYTES)).toBase64({
    alphabet: "base64url",
    omitPadding: true,
  });
