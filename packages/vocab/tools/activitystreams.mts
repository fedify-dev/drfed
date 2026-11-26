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
 * Finds about the standard entries of the known property catalog from the
 * definitions the Activity Streams namespace links them to.
 */
import {
  type ActivityPubDefinition,
  type NamespaceTerm,
  type VocabularyDefinition,
  parseActivityPub,
  parseContext,
  parseNamespaceTerms,
  parseVocabulary,
  resolveRange,
} from "./documents.mts";
import {
  type CatalogEntry,
  type Finding,
  HTML,
  JSON_LD,
  type Namespace,
  documentNamed,
  documentOf,
  findingsOf,
  fragmentOf,
} from "./namespace.mts";

const NAMESPACE_URL = "https://www.w3.org/ns/activitystreams";
const VOCABULARY_URL = "https://www.w3.org/TR/activitystreams-vocabulary/";
const ACTIVITYPUB_URL = "https://www.w3.org/TR/activitypub/";
const VOCABULARY_ORIGIN = "the Activity Vocabulary";
const ACTIVITYPUB_ORIGIN = "ActivityPub";
const NAMESPACE_ORIGIN = "the Activity Streams namespace";

/** What the namespace and the specifications it links to define. */
interface Definitions {
  /** The terms of the namespace context and the IRIs they expand to. */
  readonly terms: ReadonlyMap<string, string>;
  /** The property terms that the namespace document lists. */
  readonly namespace: readonly NamespaceTerm[];
  /** The Activity Vocabulary definitions, keyed by URI. */
  readonly vocabulary: ReadonlyMap<string, VocabularyDefinition>;
  /** The ActivityPub definitions, keyed by anchor. */
  readonly activityPub: ReadonlyMap<string, ActivityPubDefinition>;
}

const vocabularyDocument = documentOf(VOCABULARY_URL);
const activityPubDocument = documentOf(ACTIVITYPUB_URL);

const problem = (origin: string, message: string): Finding => ({
  origin,
  expected: {},
  problems: [message],
});

const withAnchor = (source: string, anchor: string): string => {
  const url = new URL(source);
  url.hash = anchor;
  return url.href;
};

const vocabularyFinding = (
  entry: CatalogEntry,
  definition: VocabularyDefinition | undefined,
  terms: ReadonlyMap<string, string>,
): Finding =>
  definition === undefined
    ? problem(
        VOCABULARY_ORIGIN,
        "the Activity Vocabulary defines no property with this URI",
      )
    : {
        origin: VOCABULARY_ORIGIN,
        expected: {
          description: definition.notes,
          range: definition.range.flatMap((written) => {
            const iri = resolveRange(terms)(written);
            return iri === undefined ? [] : [iri];
          }),
          multiple: !definition.functional,
          source: withAnchor(entry.source, definition.anchor),
        },
        problems: [],
      };

const activityPubFinding = (
  entry: CatalogEntry,
  term: NamespaceTerm,
  definition: ActivityPubDefinition | undefined,
): Finding =>
  definition === undefined
    ? problem(
        ACTIVITYPUB_ORIGIN,
        `ActivityPub defines nothing at #${fragmentOf(entry.source)}`,
      )
    : {
        origin: ACTIVITYPUB_ORIGIN,
        expected: { description: definition.text },
        problems:
          definition.term === term.term
            ? []
            : [
                `source points to the definition of ${definition.term}, not ${term.term}`,
              ],
      };

const findingOf =
  (definitions: Definitions) =>
  (iri: string, entry: CatalogEntry): Finding => {
    const document = documentOf(entry.source);
    const term = definitions.namespace.find(
      (candidate) => definitions.terms.get(candidate.term) === iri,
    );
    return term === undefined
      ? problem(
          NAMESPACE_ORIGIN,
          "the Activity Streams namespace does not define it as a property",
        )
      : documentOf(term.definition) !== document
        ? problem(
            NAMESPACE_ORIGIN,
            `source is in ${document}, but the namespace links ${term.term} to ${term.definition}`,
          )
        : document === vocabularyDocument
          ? vocabularyFinding(
              entry,
              definitions.vocabulary.get(iri),
              definitions.terms,
            )
          : activityPubFinding(
              entry,
              term,
              definitions.activityPub.get(fragmentOf(entry.source)),
            );
  };

/**
 * The Activity Streams namespace, read through the specifications it links
 * its terms to.  It covers the entries whose `source` is the Activity
 * Vocabulary or ActivityPub, wherever their IRI is: `inbox` expands to
 * `ldp:inbox`.  The IRI must be a property term of the namespace.  The
 * definition gives `description`, and an Activity Vocabulary definition also
 * gives `range`, `multiple`, and the anchor of `source`.  Entries under the
 * namespace that other vocabularies coined, such as `sensitive`, are not
 * covered.
 */
export const activityStreams: Namespace = {
  name: "Activity Streams",
  documents: {
    context: { url: NAMESPACE_URL, accept: JSON_LD },
    namespace: { url: NAMESPACE_URL, accept: HTML },
    vocabulary: { url: VOCABULARY_URL, accept: HTML },
    activityPub: { url: ACTIVITYPUB_URL, accept: HTML },
  },
  covers: (_, entry) =>
    [vocabularyDocument, activityPubDocument].includes(
      documentOf(entry.source),
    ),
  find: (entries, documents) =>
    findingsOf(
      entries,
      findingOf({
        terms: parseContext(JSON.parse(documentNamed(documents, "context"))),
        namespace: parseNamespaceTerms(documentNamed(documents, "namespace")),
        vocabulary: parseVocabulary(documentNamed(documents, "vocabulary")),
        activityPub: parseActivityPub(documentNamed(documents, "activityPub")),
      }),
    ),
};
