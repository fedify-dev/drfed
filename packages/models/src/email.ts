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

/**
 * Normalizes an email address by trimming whitespace, converting the host
 * to lowercase (and to punycode if necessary), and ensuring it has a
 * single "@" character. If the email is invalid, it throws a `TypeError`.
 * @param email The email address to normalize.
 * @returns The normalized email address.
 */
export function normalizeEmail(email: string): string;

/**
 * Normalizes an email address by trimming whitespace, converting the host
 * to lowercase (and to punycode if necessary), and ensuring it has a
 * single "@" character. If the email is invalid, it throws a `TypeError`.
 * @param email The email address to normalize.
 * @returns The normalized email address.  If the input is `null`,
 *          it returns `null`.
 */
export function normalizeEmail(email: string | null): string | null;

/**
 * Normalizes an email address by trimming whitespace, converting the host
 * to lowercase (and to punycode if necessary), and ensuring it has a
 * single "@" character. If the email is invalid, it throws a `TypeError`.
 * @param email The email address to normalize.
 * @returns The normalized email address.  If the input is `undefined`,
 *          it returns `undefined`.
 */
export function normalizeEmail(email: string | undefined): string | undefined;

/**
 * Normalizes an email address by trimming whitespace, converting the host
 * to lowercase (and to punycode if necessary), and ensuring it has a
 * single "@" character. If the email is invalid, it throws a `TypeError`.
 * @param email The email address to normalize.
 * @returns The normalized email address.  If the input is `undefined`,
 *          it returns `undefined`.  If the input is `null`, it returns `null`.
 */
export function normalizeEmail(
  email: string | null | undefined,
): string | null | undefined;

export function normalizeEmail(
  email: string | null | undefined,
): string | null | undefined {
  if (typeof email === "undefined") return undefined;
  else if (email == null) return null;
  const [local, host, shouldNotExist] = email.trim().split("@");
  if (
    local == null ||
    local.trim() === "" ||
    host == null ||
    host.trim() === "" ||
    shouldNotExist != null
  ) {
    throw new TypeError("Invalid email format.");
  }
  const normalizedHost = new URL(`https://${host}/`).host;
  return `${local}@${normalizedHost}`;
}
