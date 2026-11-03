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

// The documentation includes regions of the shell scripts under docker/ with
// VitePress's `<<< file#region` syntax, and the container tests run the same
// regions, so that a reader copies exactly the text that was tested.

const marker = (line: string) =>
  /^# ?(?<tag>(?:end)?region) (?<name>[\w*-]+)$/u.exec(line.trim())?.groups;

/**
 * Extract a region the way VitePress does for a shell script: the lines
 * between `# region <name>` and `# endregion <name>`, without any other
 * region marker.  Unlike VitePress, which falls back to the whole file, a
 * missing region is an error; the regions are not indented, so VitePress's
 * dedent is left out.
 * @returns The region's text, ending with a newline.
 */
export function snippetRegion(script: string, name: string): string {
  const lines = script.split("\n");
  const start = lines.findIndex((line) => {
    const found = marker(line);
    return found?.tag === "region" && found.name === name;
  });
  const end = lines.findIndex((line, index) => {
    const found = marker(line);
    return index > start && found?.tag === "endregion" && found.name === name;
  });
  if (start < 0 || end < 0) throw new Error(`No region ${name}.`);
  return `${lines
    .slice(start + 1, end)
    .filter((line) => marker(line) === undefined)
    .join("\n")}\n`;
}
