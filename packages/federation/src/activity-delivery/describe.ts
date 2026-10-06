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

import { Object as APObject, Activity, getTypeId } from "@fedify/vocab";

type Options = Parameters<typeof Activity.fromJsonLd>[1];

function document(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/**
 * PostgreSQL text holds no U+0000; the original stays in the raw request.
 * @returns Whether the value is a string text can hold.
 */
const text = (value: unknown): value is string =>
  typeof value === "string" && !value.includes("\0");
const string = (value: unknown): string | null => (text(value) ? value : null);
const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter(text);
const first = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Keep an untrusted IRI only when it is an absolute URL text can hold; the
 * original stays in the raw request.
 * @returns The IRI, or null when it is not a valid URL or holds U+0000.
 */
export const iri = (value: unknown): string | null =>
  text(value) && URL.canParse(value) ? value : null;

/**
 * Parse JSON-LD as an activity without dereferencing.
 * @returns The activity, or null when the document is not one.
 */
export async function parseActivity(
  payload: unknown,
  options: Options = {},
): Promise<Activity | null> {
  try {
    // The Activity constructor accepts even {} as a base Activity. Parse the
    // actual vocabulary type first so malformed JSON does not invent a type.
    const activity = await APObject.fromJsonLd(payload, options);
    return activity instanceof Activity ? activity : null;
  } catch {
    return null;
  }
}

function resolvedType(types: readonly string[], activity: Activity) {
  const { href, hash } = getTypeId(activity);
  return (
    types.find((type) => type === href || `#${type}` === hash) ??
    types[0] ??
    null
  );
}

/**
 * Describe an already parsed activity.
 * @returns Best-effort activity metadata.
 */
export async function describeParsed(
  payload: unknown,
  activity: Activity | null,
  options: Options = {},
) {
  const raw = document(payload);
  const types = strings(raw.type ?? raw["@type"]);
  if (activity == null) {
    return {
      type: string(raw.type),
      types,
      activityIri: iri(raw.id),
      remoteActorIri: iri(raw.actor),
      objectType: null,
      objectIri: null,
    };
  }
  const value = document(
    await activity.toJsonLd({ ...options, format: "compact" }),
  );
  const object = document(first(value.object));
  return {
    type: string(value.type) ?? resolvedType(types, activity),
    types,
    activityIri: iri(value.id),
    remoteActorIri: activity.actorIds[0]?.href ?? null,
    objectType: string(first(object.type)),
    objectIri: iri(first(value.object)) ?? iri(object.id),
  };
}

/**
 * Describe JSON-LD without dereferencing its actor or object.
 * @returns Best-effort activity metadata.
 */
export async function describeActivity(
  payload: unknown,
  options: Options = {},
) {
  return await describeParsed(
    payload,
    await parseActivity(payload, options),
    options,
  );
}

/**
 * Best-effort host extraction from untrusted activity metadata.
 * @returns The remote host, or null when unavailable.
 */
export function remoteHost(
  actorIri: string | null,
  keyIri: string | null,
): string | null {
  const url = iri(actorIri ?? keyIri);
  return url == null ? null : new URL(url).host || null;
}
