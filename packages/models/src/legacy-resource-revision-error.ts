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

import type { Uuid } from "./uuid.ts";

/** Legacy typed rows require the coordinated application adapter in #152. */
export class LegacyResourceRevisionError extends Error {
  constructor(readonly resourceId: Uuid) {
    super(
      "A legacy typed resource cannot be changed through the generic revision API.",
    );
    this.name = "LegacyResourceRevisionError";
  }
}
