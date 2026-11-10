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
 * What names an actor to a reader: its handle, or its IRI for a remote actor
 * that has no `preferredUsername`.
 * @returns The handle or the IRI.
 */
export const actorLabel = (actor: {
  readonly handle?: string | null | undefined;
  readonly iri: string;
}): string => actor.handle ?? actor.iri;

const activityStreams = "https://www.w3.org/ns/activitystreams#";

/**
 * What names a vocabulary type to a reader: the term of an ActivityStreams
 * type, such as `Note`, or any other type IRI in full.  Show the full IRI
 * beside it, as a `title` for one, since a term hides its namespace.
 * @returns The term or the IRI.
 */
export const typeLabel = (iri: string): string =>
  iri.startsWith(activityStreams) && iri.length > activityStreams.length
    ? iri.slice(activityStreams.length)
    : iri;
