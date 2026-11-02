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

import type { Database, Transaction } from "@drfed/models";
import type {
  Diagnostic,
  FieldPath,
  JsonValue,
  NormalizationChange,
} from "@drfed/models/document";
import type { AddressingOccurrence } from "@drfed/models/resource";
import type { RevisionRelationInput } from "@drfed/models/resource-revision";
import type { Uuid } from "@drfed/models/uuid";
import type { Federation } from "@fedify/fedify";

/** A parsed JSON object, as editors submit documents. */
export type JsonObject = { readonly [key: string]: JsonValue };

/** What the write operations need from the running server. */
export interface LocalWriteEnvironment {
  readonly db: Database;
  /** The federation whose router composes resource IRIs. */
  readonly federation: Federation<unknown>;
  /** The root origin every instance is a subdomain of. */
  readonly rootOrigin: URL;
  /**
   * The HMAC-SHA256 key that signs preview tokens.  A random key kept in
   * memory per server process is enough: a restart only makes outstanding
   * previews stale.
   */
  readonly previewKey: CryptoKey;
}

/** The authenticated account; trusted, never taken from request input. */
export interface WritePrincipal {
  readonly accountId: Uuid;
}

/** A document in the request to save as a new local resource. */
export interface NewResource {
  /** The source path of the document; `[]` is the root. */
  readonly path: FieldPath;
  readonly kind: "object" | "activity";
  /**
   * Whether the saved parent keeps the new resource embedded, as submitted,
   * or replaces it with the new resource's IRI.  Only for nested resources.
   */
  readonly representation?: "embedded" | "reference";
}

/** Saves new resources: an object alone, an activity, or both nested. */
export interface CreateRequest {
  readonly operation: "create";
  /** The acting local actor, which authors every new resource. */
  readonly actorId: Uuid;
  readonly document: JsonObject;
  /** Must name the root, `[]`, and may name nested embedded documents. */
  readonly resources: readonly NewResource[];
  /** Adds the root activity to the actor's outbox; needs a reservation. */
  readonly publish?: boolean;
}

/**
 * Commits an actual edit of a current local object: its new version, and a
 * generated `Update` that embeds it, in the actor's outbox.
 */
export interface EditRequest {
  readonly operation: "edit";
  readonly actorId: Uuid;
  readonly objectId: Uuid;
  /** The revision the edit was made from; a newer one is a conflict. */
  readonly expectedRevisionId: Uuid;
  /** The complete new version, usually the loaded document changed. */
  readonly document: JsonObject;
}

/**
 * Commits an actual deletion of a current local object: a whiteout, and a
 * generated `Delete` in the actor's outbox.
 */
export interface DeleteRequest {
  readonly operation: "delete";
  readonly actorId: Uuid;
  readonly objectId: Uuid;
  readonly expectedRevisionId: Uuid;
}

export type LocalWriteRequest = CreateRequest | EditRequest | DeleteRequest;

export type LocalWriteErrorType =
  | "invalid_request"
  | "invalid_document"
  | "actor_not_found"
  | "invalid_instance_host"
  | "stale_preview"
  | "revision_conflict"
  | "resource_conflict"
  | "unsupported_edit";

export interface LocalWriteError {
  readonly type: LocalWriteErrorType;
  /** For people; use `type` and `diagnostics` for decisions. */
  readonly message: string;
  /** Document findings at submitted paths, for `invalid_document`. */
  readonly diagnostics: readonly Diagnostic[];
}

/** A resource as a commit with the same preview token would save it. */
export interface PreparedResource {
  /** The submitted path; `[]` for an edited object or generated activity. */
  readonly path: FieldPath;
  /** Whether the server composed it, as the `Update` of an edit. */
  readonly generated: boolean;
  readonly kind: "object" | "activity";
  readonly id: Uuid;
  readonly iri: string;
  /** The complete document to save, including protected blind recipients. */
  readonly document: JsonObject;
  readonly addressing: readonly AddressingOccurrence[];
  readonly relations: readonly RevisionRelationInput[];
}

export interface LocalWritePreview {
  /** Findings at submitted paths; warnings do not block a commit. */
  readonly diagnostics: readonly Diagnostic[];
  /** Every change between the submitted and saved documents. */
  readonly changes: readonly NormalizationChange[];
  /**
   * Root last, after the resources it contains; for an edit, the new
   * version then the `Update`; for a deletion, the `Delete`.
   */
  readonly resources: readonly PreparedResource[];
  /** For an edit or deletion, the revision it was checked against. */
  readonly currentRevisionId?: Uuid;
  /** Pass to the commit to save exactly these values. */
  readonly token: string;
}

export interface SavedResource extends PreparedResource {
  readonly revisionId: Uuid;
}

export interface LocalWriteResult {
  /** In the order of the preview's resources. */
  readonly resources: readonly SavedResource[];
  /** Whether an activity was added to the actor's outbox. */
  readonly published: boolean;
  /** For a deletion, the whiteout revision of the deleted object. */
  readonly whiteoutRevisionId?: Uuid;
}

export type PreviewOutcome =
  | { readonly ok: true; readonly preview: LocalWritePreview }
  | { readonly ok: false; readonly error: LocalWriteError };

export type CommitOutcome =
  | { readonly ok: true; readonly result: LocalWriteResult }
  | { readonly ok: false; readonly error: LocalWriteError };

export interface CommitOptions {
  /** The token of the approved preview. */
  readonly previewToken: string;
  /**
   * Reserves the durable dispatch of a published or generated activity.  It
   * runs inside the write's transaction after every other write, may only
   * persist in that transaction, and rolls the whole write back by throwing.
   * Required to publish, edit, or delete; never called otherwise.
   */
  readonly reserveDispatch?: (
    tx: Transaction,
    activity: SavedResource,
  ) => Promise<void>;
}

/**
 * Builds an outcome error.
 * @returns The error.
 */
export function writeError(
  type: LocalWriteErrorType,
  message: string,
  diagnostics: readonly Diagnostic[] = [],
): LocalWriteError {
  return { type, message, diagnostics };
}

/**
 * Carries an outcome out of a transaction, so that returning a failure can
 * never commit what the transaction wrote before it.
 */
export class LocalWriteRollback extends Error {
  constructor(readonly error: LocalWriteError) {
    super(error.message);
    this.name = "LocalWriteRollback";
  }
}
