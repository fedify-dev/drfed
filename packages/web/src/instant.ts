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

// The `DateTime` scalar is `Temporal.Instant#toString()`: UTC, seconds always
// present, and a fraction trimmed to the digits it needs, such as
// `2026-11-10T10:55:35.72Z` or `2026-11-10T10:55:35.725074Z`.
const DATE_TIME =
  /^(?<base>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(?<fraction>\d{1,9}))?Z$/u;

/**
 * Spells a `DateTime` value with all nine fraction digits, so that values
 * order as strings without losing the precision `Date` would drop.
 * @returns The fixed-width spelling, or `undefined` for another format.
 */
const fixedWidth = (value: string): string | undefined => {
  const groups = DATE_TIME.exec(value)?.groups;
  return groups?.base === undefined
    ? undefined
    : `${groups.base}.${(groups.fraction ?? "").padEnd(9, "0")}Z`;
};

/**
 * Orders two `DateTime` values exactly as the server wrote them.
 * @returns A negative number when `left` is earlier, zero when they are the
 *          same instant, a positive number when `left` is later, or
 *          `undefined` when either is not in the scalar's format.
 */
export function compareDateTimes(
  left: string,
  right: string,
): number | undefined {
  const [fixedLeft, fixedRight] = [fixedWidth(left), fixedWidth(right)];
  if (fixedLeft === undefined || fixedRight === undefined) return undefined;
  if (fixedLeft === fixedRight) return 0;
  return fixedLeft < fixedRight ? -1 : 1;
}
