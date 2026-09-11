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
import { v7, validate } from "uuid";

/**
 * A UUID string.  It does not guarantee that the string is a normalized UUID.
 */
export type Uuid = ReturnType<typeof crypto.randomUUID>;

/**
 * Compares two UUIDs for equality, ignoring case.
 * @param left A UUID string to compare.
 * @param right Another UUID string to compare.
 * @returns `true` if the UUIDs are equal (ignoring case), `false` otherwise.
 */
export function areUuidsEqual(left: Uuid, right: Uuid): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Generates a new UUIDv7 string.
 * @returns A new UUIDv7 string.
 */
export function uuidV7(): Uuid {
  return v7() as Uuid;
}

/**
 * Validate UUID.
 * @param value A Value to validate.
 * @returns `true` if the input is `Uuid`.
 */
export const validateUuid = (value: unknown): value is Uuid => validate(value);
