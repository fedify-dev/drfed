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
import catalog from "./properties.yaml";

/**
 * Text keyed by BCP 47 language tag.  English is always present.
 */
export interface LocalizedText {
  readonly en: string;
  readonly [language: string]: string;
}

/**
 * Metadata about one property, as its defining vocabulary describes it.
 */
export interface KnownProperty {
  /** A short human-readable name for the property. */
  readonly label: LocalizedText;
  /** What the property means. */
  readonly description: LocalizedText;
  /**
   * The absolute IRIs of the types and datatypes the vocabulary declares as
   * the property's range.  Absent when the vocabulary declares none.
   */
  readonly range?: readonly string[];
  /**
   * Whether the vocabulary allows more than one value.  Absent when the
   * vocabulary does not say; absence does not mean single-valued.
   */
  readonly multiple?: boolean;
  /** A link to the property's definition. */
  readonly source: string;
}

/**
 * Known properties keyed by their absolute property IRIs.  A lookup by an
 * arbitrary IRI may find no entry, so its type includes `undefined` whatever
 * the consumer's compiler options are.
 */
export type KnownProperties = Readonly<
  Record<string, KnownProperty | undefined>
>;

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

/**
 * The catalog of known properties, keyed by absolute property IRI.  Looking up
 * an IRI that is not listed returns `undefined`; being unlisted only means the
 * catalog has no metadata for the property, not that the property is invalid.
 *
 * The object and its entries are frozen and the object has no prototype, so
 * a lookup such as `knownProperties["constructor"]` also returns `undefined`.
 */
export const knownProperties: KnownProperties = deepFreeze(
  Object.assign(Object.create(null) as Record<string, KnownProperty>, catalog),
);
