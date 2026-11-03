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
 * The directory names of the public packages under packages/, each after
 * the packages it depends on.  Packing, publishing and installing follow this
 * order, and `mise run check:packages` compares it with packages/ and with
 * the tarballs that docker/Containerfile installs.
 */
export const packageOrder = [
  "models",
  "federation",
  "graphql",
  "web",
  "drfed",
] as const;
