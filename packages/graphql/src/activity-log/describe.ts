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

import { Object as APObject, Activity } from "@fedify/vocab";

function document(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const string = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Describe JSON-LD without dereferencing its actor or object.
 * @returns Best-effort activity metadata.
 */
export async function describeActivity(
  payload: unknown,
  options: Parameters<typeof Activity.fromJsonLd>[1] = {},
) {
  let value = document(payload);
  try {
    // The Activity constructor accepts even {} as a base Activity. Parse the
    // actual vocabulary type first so malformed JSON does not invent a type.
    const activity = await APObject.fromJsonLd(payload, options);
    if (!(activity instanceof Activity)) {
      throw new TypeError("Expected an ActivityStreams activity.");
    }
    value = document(
      await activity.toJsonLd({ ...options, format: "compact" }),
    );
  } catch {
    return {
      type: string(value.type),
      activityIri: string(value.id),
      remoteActorIri: string(value.actor),
      objectType: null,
      objectIri: null,
    };
  }
  const object = document(value.object);
  return {
    type: string(value.type),
    activityIri: string(value.id),
    remoteActorIri: string(value.actor) ?? string(document(value.actor).id),
    objectType: string(object.type),
    objectIri: string(value.object) ?? string(object.id),
  };
}

/**
 * Best-effort host extraction from untrusted activity metadata.
 * @returns The remote host, or null when unavailable.
 */
export function remoteHost(
  actorIri: string | null,
  keyIri: string | null,
): string | null {
  const iri = actorIri ?? keyIri;
  return iri != null && URL.canParse(iri) ? new URL(iri).host || null : null;
}
