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
 * The serialization of saved resources that federation reads use, for
 * outgoing payloads to share: a saved document is served as it was saved,
 * without blind recipients in it or in any document it embeds.  It can be
 * parsed into a Fedify vocabulary object that keeps that representation.
 * Nothing here delivers or dereferences anything.
 * @module
 */

export {
  type ServedDocument,
  parseVocab,
  publicDocument,
  serveDocument,
} from "./serving/document.ts";
export {
  type ActivitySnapshot,
  loadActivitySnapshot,
} from "./serving/resource.ts";
