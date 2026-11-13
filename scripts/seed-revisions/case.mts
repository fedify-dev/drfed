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

import type { LocalWriteEnvironment } from "@drfed/federation/local-write";
import type { Database } from "@drfed/models";
import type { Uuid } from "@drfed/models/uuid";

import type { Workspace } from "./environment.mts";
import type { Writer } from "./writer.mts";

export const CAROL_IRI = "https://mastodon.example/users/carol";
export const CAROL_FOLLOWERS_IRI = `${CAROL_IRI}/followers`;

/**
 * Composes the IRI of one of Carol's notes.
 * @returns The IRI.
 */
export const carolNote = (name: string): string =>
  `https://mastodon.example/users/carol/statuses/${name}`;

/** What every case works with. */
export interface CaseContext {
  readonly db: Database;
  readonly env: LocalWriteEnvironment;
  /** Workspace A, whose actor writes every local resource. */
  readonly alice: Workspace;
  /** Workspace B, which only receives. */
  readonly bob: Workspace;
  /** Writes as the actor of workspace A. */
  readonly writer: Writer;
}

/** A resource to open in the UI to see a case. */
export interface SeededResource {
  readonly label: string;
  readonly id: Uuid;
  readonly iri: string;
}

export interface SeededCase {
  readonly number: number;
  readonly title: string;
  readonly resources: readonly SeededResource[];
}

export type SeedCase = (context: CaseContext) => Promise<SeededCase>;

/**
 * Labels a saved resource for the report.
 * @returns The labelled resource.
 */
export const labelled = (
  label: string,
  { id, iri }: { readonly id: Uuid; readonly iri: string },
): SeededResource => ({ label, id, iri });
