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

// Rules verified at these upstream revisions:
// mastodon/mastodon fba604991b404096878932691b7673c61357f65c
// app/lib/activitypub/parser/status_parser.rb and app/lib/activitypub/tag_manager.rb
// misskey-dev/misskey 5e52f8609913a7a4f8bc76cbe26c2b99938310ae
// packages/backend/src/core/activitypub/ApAudienceService.ts
import { PUBLIC_IRI } from "@drfed/models/resource";

/** Missing/null properties permit Mastodon's activity fallback; [] does not. */
export interface AddressingRows {
  readonly to?: readonly string[] | null | undefined;
  readonly cc?: readonly string[] | null | undefined;
}
export interface ExpectedClassification {
  readonly implementation: "MASTODON" | "MISSKEY";
  readonly version: string;
  readonly classification: string;
  readonly reason: string;
}
interface Author {
  readonly followersIri: string | null;
  readonly iri: string;
}
const isPublic = (iri: string): boolean =>
  [PUBLIC_IRI, "as:Public", "Public"].includes(iri);

/**
 * Expected Mastodon classification, independent of receiver state or policy.
 * @returns The expected Mastodon label, pinned revision, and applied rule.
 */
export function classifyMastodon(
  object: AddressingRows,
  activity: AddressingRows | null,
  author: Author,
): ExpectedClassification {
  const to = object.to ?? activity?.to ?? [];
  const cc = object.cc ?? activity?.cc ?? [];
  const [classification, rule]: readonly [string, string] = to.some(isPublic)
    ? ["public", "Public is in to"]
    : cc.some(isPublic)
      ? ["unlisted", "Public is in cc"]
      : author.followersIri != null && to.includes(author.followersIri)
        ? ["private", "The author's followers collection is in to"]
        : [
            "direct",
            "Neither Public nor the author's followers collection occurs in to, and Public is absent from cc",
          ];
  return {
    implementation: "MASTODON",
    version: "fba604991b404096878932691b7673c61357f65c",
    classification,
    reason: `Expected: ${rule}. Missing object properties fall back to the activity. Receiver state and policy can change access.`,
  };
}

/**
 * Expected Misskey classification; activity addressing is deliberately unused.
 * @returns The expected Misskey label, pinned revision, and applied rule.
 */
export function classifyMisskey(
  object: AddressingRows,
  _activity: AddressingRows | null,
  author: Author,
): ExpectedClassification {
  const to = object.to ?? [];
  const cc = object.cc ?? [];
  const followers = author.followersIri ?? `${author.iri}/followers`;
  const [classification, rule]: readonly [string, string] = to.some(isPublic)
    ? ["public", "Public is in to"]
    : cc.some(isPublic)
      ? ["home", "Public is in cc"]
      : [...to, ...cc].includes(followers)
        ? ["followers", "The author's followers collection is in to or cc"]
        : [
            "specified",
            "Public and the author's followers collection are absent from to and cc",
          ];
  return {
    implementation: "MISSKEY",
    version: "5e52f8609913a7a4f8bc76cbe26c2b99938310ae",
    classification,
    reason: `Expected: ${rule}. Only object addressing is considered. Receiver state and policy can change access.`,
  };
}

/**
 * Converts stored addressing while preserving absent properties for fallback.
 * @returns Addressing suitable for the classification rules.
 */
export function classificationInput(row: {
  document: unknown;
  addressing: readonly {
    property: string;
    position: number;
    targetResource: { iri: string };
  }[];
}): AddressingRows {
  const property = (name: "to" | "cc"): readonly string[] | undefined => {
    const rows = row.addressing
      .filter((entry) => entry.property === name)
      .toSorted((left, right) => left.position - right.position);
    if (rows.length > 0) return rows.map((entry) => entry.targetResource.iri);
    const { document } = row;
    return document != null &&
      typeof document === "object" &&
      name in document &&
      document[name as keyof typeof document] != null
      ? []
      : undefined;
  };
  return { to: property("to"), cc: property("cc") };
}

/**
 * Extracts the object author's canonical IRI and declared followers IRI.
 * @returns The author identifiers used by the classification rules.
 */
export function classificationAuthor(actor: {
  resource: { iri: string };
  collectionReferences: readonly {
    role: string;
    collection: { resource: { iri: string } };
  }[];
}): Author {
  return {
    iri: actor.resource.iri,
    followersIri:
      actor.collectionReferences.find((entry) => entry.role === "followers")
        ?.collection.resource.iri ?? null,
  };
}
