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

import {
  containerMarker,
  defaultListenHost,
} from "@drfed/drfed/listen-defaults";

it("listens on every interface by default only inside the container image", () => {
  const lookup = (value: string | undefined) => (name: string) =>
    name === containerMarker ? value : undefined;
  assert.equal(containerMarker, "DRFED_CONTAINER");
  assert.equal(defaultListenHost(lookup(undefined)), "localhost");
  for (const value of ["1", "true", "yes", "on", "TRUE"]) {
    assert.equal(defaultListenHost(lookup(value)), "0.0.0.0", value);
  }
  for (const value of ["", "0", "false", "no", "off", "container"]) {
    assert.equal(defaultListenHost(lookup(value)), "localhost", value);
  }
});
