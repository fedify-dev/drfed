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

import { storableText } from "@drfed/models";
import type { JsonValue } from "@drfed/models/document";
import type { ActivityPubObject } from "@drfed/models/schema";

import type { JsonObject } from "./types.ts";

const activityStreams = "https://www.w3.org/ns/activitystreams";
const security = "https://w3id.org/security/v1";

/**
 * The context an edit of a typed object uses instead of the Fedify context
 * its legacy document was serialized with, which the validator cannot read
 * offline.  It keeps the one non-ActivityStreams term the typed columns
 * serve, `sensitive`.
 */
export const typedContext: JsonValue = [
  activityStreams,
  { sensitive: "as:sensitive" },
];

const typedContexts: readonly string[] = [
  activityStreams,
  [activityStreams],
  [activityStreams, security],
  typedContext,
  [activityStreams, security, { sensitive: "as:sensitive" }],
].map((context) => JSON.stringify(context));

const typedKeys: ReadonlySet<string> = new Set([
  "@context",
  "id",
  "type",
  "attributedTo",
  "content",
  "contentMap",
  "name",
  "summary",
  "sensitive",
  "published",
  "updated",
  "url",
  "to",
  "cc",
  "bto",
  "bcc",
  "audience",
]);

/** The typed columns a document projects onto, besides addressing. */
export interface TypedProjection {
  readonly type: ActivityPubObject["type"];
  readonly attributedTo: string;
  readonly contentHtml: string;
  readonly language: string | null;
  readonly name: string | null;
  readonly summary: string | null;
  readonly url: string | null;
  readonly sensitive: boolean;
  readonly published: Temporal.Instant;
  readonly updated: Temporal.Instant;
}

function optionalText(value: JsonValue | undefined): string | null | false {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && storableText(value) ? value : false;
}

function instant(value: JsonValue | undefined): Temporal.Instant | null {
  if (typeof value !== "string") return null;
  try {
    return Temporal.Instant.from(value);
  } catch {
    return null;
  }
}

/**
 * Reads the language of a single-language `contentMap` equal to `content`,
 * as the typed `language` column stores it.
 * @returns The canonical tag, null without a map, or false when the map
 *          does not fit the column.
 */
function contentLanguage(
  contentMap: JsonValue | undefined,
  content: string,
): string | null | false {
  if (contentMap === undefined || contentMap === null) return null;
  if (typeof contentMap !== "object" || Array.isArray(contentMap)) {
    return false;
  }
  const entries = Object.entries(contentMap);
  if (entries.length !== 1 || entries[0]![1] !== content) return false;
  const [tag] = entries[0]!;
  try {
    return Intl.getCanonicalLocales(tag)[0] === tag && tag.length <= 35
      ? tag
      : false;
  } catch {
    return false;
  }
}

/**
 * Checks a context against those an edited typed object may use.
 * @returns Whether the context is one of them.
 */
export function isTypedContext(context: JsonValue | undefined): boolean {
  return typedContexts.includes(JSON.stringify(context));
}

function hasTypedShape(document: JsonObject, legacyContext: boolean): boolean {
  const { type, attributedTo, content, sensitive } = document;
  return (
    Object.keys(document).every((key) => typedKeys.has(key)) &&
    (legacyContext || isTypedContext(document["@context"])) &&
    (type === "Note" || type === "Article") &&
    typeof attributedTo === "string" &&
    typeof sensitive === "boolean" &&
    typeof content === "string" &&
    content.trim() !== "" &&
    storableText(content)
  );
}

/**
 * Projects a Note or Article document onto the columns legacy serving reads,
 * only when they represent it without loss.  Addressing, kept in its own
 * rows, is checked by the caller.
 * @param legacyContext Accept the context legacy serialization wrote.
 * @returns The columns, or null when the document does not fit them.
 */
export function projectTypedObject(
  document: JsonObject,
  legacyContext = false,
): TypedProjection | null {
  if (!hasTypedShape(document, legacyContext)) return null;
  const content = document.content as string;
  const language = contentLanguage(document.contentMap, content);
  const name = optionalText(document.name);
  const summary = optionalText(document.summary);
  const url = optionalText(document.url);
  const published = instant(document.published);
  const updated = instant(document.updated);
  if (
    language === false ||
    name === false ||
    summary === false ||
    url === false ||
    published == null ||
    updated == null
  ) {
    return null;
  }
  return {
    type: document.type as TypedProjection["type"],
    attributedTo: document.attributedTo as string,
    contentHtml: content,
    language,
    name,
    summary,
    url,
    sensitive: document.sensitive as boolean,
    published,
    updated,
  };
}

/**
 * Checks that a typed row still holds what its current document projects
 * onto, i.e. that nothing changed a served column without the history.
 * @returns Whether the row agrees with the document's projection.
 */
export function agreesWithRow(
  projection: TypedProjection,
  row: ActivityPubObject,
  actorIri: string,
): boolean {
  return (
    projection.type === row.type &&
    projection.attributedTo === actorIri &&
    projection.contentHtml === row.contentHtml &&
    projection.language === row.language &&
    projection.name === row.name &&
    projection.summary === row.summary &&
    projection.url === row.url &&
    projection.sensitive === row.sensitive &&
    projection.published.equals(row.published) &&
    projection.updated.equals(row.updated) &&
    row.deleted == null
  );
}
