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
 * The interpretation of saved documents by meaning: the relations,
 * recipients and extension properties of the root and of every document it
 * embeds, as the validator reads them.  The indexes local writes save and the
 * GraphQL read surface share it, so that they cannot disagree.  Nothing here
 * dereferences anything.
 * @module
 */

export {
  type InterpretedNode,
  RELATION_PROPERTIES,
  type RecipientOccurrence,
  type RecipientProperty,
  type RelationOccurrence,
  type RelationProperty,
  type Representation,
  interpretDocument,
} from "./document/interpret.ts";
