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
 * The common write operations on local resources: saving an object alone,
 * an activity referring to existing resources, or an activity with new
 * nested resources, atomically; and committing an actual edit or deletion
 * of a current object with its generated `Update` or `Delete`.  Editors
 * preview a write, show its changes, and commit it with the preview's token.
 * Saving never delivers anything.
 * @module
 */

export {
  type LegacyObject,
  type LegacyObjectInput,
  createLegacyObject,
} from "./local-write/legacy.ts";
export {
  commitLocalWrite,
  previewLocalWrite,
} from "./local-write/operation.ts";
export { isLocalWriteError } from "./local-write/types.ts";
export type {
  CommitOptions,
  CommitOutcome,
  CreateRequest,
  DeleteRequest,
  EditRequest,
  JsonObject,
  LocalWriteEnvironment,
  LocalWriteError,
  LocalWriteErrorType,
  LocalWritePreview,
  LocalWriteRequest,
  LocalWriteResult,
  NewResource,
  PreparedResource,
  PreviewOutcome,
  SavedResource,
  WritePrincipal,
} from "./local-write/types.ts";
