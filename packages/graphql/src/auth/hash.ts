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

// oxlint-disable no-magic-numbers
const BASE36_CHAR = "0123456789abcdefghijklmnopqrstuvwxyz";

// It's not strictly uniform random sampling, but it's negligible enough.
export const generateBase36Code = (len: number): string =>
  Array.from(
    // Choose `Uint16Array` cause `2 ** 16 % 36 = 16`
    // It's greater than `2 ** 8 % 36 = 2 ** 32 % 36 = 4`.
    crypto.getRandomValues(new Uint16Array(len)),
    (num) => BASE36_CHAR[num % BASE36_CHAR.length],
  ).join("");

export const hashSecret = async (raw: string): Promise<string> =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(raw)),
  ).toHex();

const textEncoder = new TextEncoder();

export async function equalSecretHashes(
  leftHash: string,
  rightHash: string,
): Promise<boolean> {
  const macs = (await Promise.all([leftHash, rightHash].map(getHmac))).map(
    (buf) => new Uint8Array(buf),
  );

  // oxlint-disable-next-line no-bitwise id-length
  const difference = macs[0]!.reduce((p, c, i) => p | (c ^ macs[1]![i]!), 0);

  return difference === 0;
}
const compareKey = await crypto.subtle.generateKey(
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const getHmac = (hash: string) =>
  crypto.subtle.sign("HMAC", compareKey, textEncoder.encode(hash));

const ACCESS_TOKEN_BYTES = 32;

export const generateAccessToken = (): string =>
  crypto.getRandomValues(new Uint8Array(ACCESS_TOKEN_BYTES)).toBase64({
    alphabet: "base64url",
    omitPadding: true,
  });
