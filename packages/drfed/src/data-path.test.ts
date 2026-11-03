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

import assert from "node:assert/strict";
import { it } from "node:test";

import { defaultPgliteDataPath } from "@drfed/drfed/data-path";

it("uses platform-specific persistent locations and only absolute OS overrides", () => {
  assert.equal(
    defaultPgliteDataPath("darwin", "/home/user", {}),
    "/home/user/Library/Application Support/DrFed/data",
  );
  assert.equal(
    defaultPgliteDataPath("linux", "/home/user", {}),
    "/home/user/.local/share/drfed/data",
  );
  assert.equal(
    defaultPgliteDataPath("linux", "/home/user", {
      XDG_DATA_HOME: "/var/data",
    }),
    "/var/data/drfed/data",
  );
  assert.equal(
    defaultPgliteDataPath("linux", "/home/user", { XDG_DATA_HOME: "relative" }),
    "/home/user/.local/share/drfed/data",
  );
  assert.equal(
    defaultPgliteDataPath("win32", "C:\\Users\\user", {
      LOCALAPPDATA: "D:\\Data",
    }),
    "D:\\Data\\DrFed\\data",
  );
  assert.equal(
    defaultPgliteDataPath("win32", "C:\\Users\\user", {
      LOCALAPPDATA: "relative",
    }),
    "C:\\Users\\user\\AppData\\Local\\DrFed\\data",
  );
});

it("looks the home directory up only when no absolute override replaces it", () => {
  const unavailable = () => {
    throw new Error("No home directory.");
  };
  assert.equal(
    defaultPgliteDataPath("linux", unavailable, { XDG_DATA_HOME: "/var/lib" }),
    "/var/lib/drfed/data",
  );
  assert.equal(
    defaultPgliteDataPath("win32", unavailable, { LOCALAPPDATA: "D:\\Data" }),
    "D:\\Data\\DrFed\\data",
  );
  assert.throws(
    () => defaultPgliteDataPath("linux", unavailable, {}),
    /No home directory/u,
  );
  assert.equal(
    defaultPgliteDataPath("linux", () => "/home/user", {}),
    "/home/user/.local/share/drfed/data",
  );
});
