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
function jsonKeys(value: object): string[] {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    Array.isArray(value)
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  ) {
    throw new TypeError("JSON objects must be plain records.");
  }
  const result: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      descriptor === undefined ||
      !("value" in descriptor)
    ) {
      throw new TypeError(
        "JSON values cannot contain symbol keys or accessors.",
      );
    }
    if (Array.isArray(value) && key === "length") continue;
    if (!descriptor.enumerable) {
      throw new TypeError("JSON members must be enumerable.");
    }
    if (
      Array.isArray(value) &&
      (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)
    ) {
      throw new TypeError("JSON arrays cannot contain named properties.");
    }
    result.push(key);
  }
  return result;
}

/**
 * Serializes a JSON value without coercion, keeping negative zero and
 * escaped Unicode, for storage in `json` columns.
 * @param value The value to serialize.
 * @param ancestors Objects being serialized, to reject cycles.
 * @returns The JSON text.
 */
export function json(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JSON numbers must be finite.");
    }
    return Object.is(value, -0) ? "-0" : JSON.stringify(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError("Expected an acyclic JSON value without coercion.");
  }
  const keys = jsonKeys(value);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (entry: unknown) => json(entry, ancestors)).join(",")}]`;
    }
    return `{${keys.map((key) => `${JSON.stringify(key)}:${json(Object.getOwnPropertyDescriptor(value, key)!.value, ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
