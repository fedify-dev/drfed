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

// A written range that names no type by nature: a quoted value such as
// `"cm"`, or prose such as `MIME Media Type` that names no compact IRI.
const isProse = (written: string): boolean =>
  written.startsWith('"') ||
  (!/^[A-Za-z][\w-]*:/u.test(written) && /[\s[]/u.test(written));

// What the written ranges of a definition give: the IRIs of all of them, an
// empty range when every one is prose that names no type, or, when some of
// them name nothing the context resolves or are prose beside types, no range
// and the problem that says why.
const rangeOf = (
  written: readonly string[],
  terms: ReadonlyMap<string, string>,
): Pick<Finding, "expected" | "problems"> => {
  const resolved = written.map((range) => resolveRange(terms)(range));
  const unresolved = written.filter(
    (_, index) => resolved[index] === undefined,
  );
  if (unresolved.length === 0) {
    return {
      expected: { range: [...new Set(resolved as readonly string[])] },
      problems: [],
    };
  }
  if (unresolved.length === written.length && unresolved.every(isProse)) {
    return { expected: { range: [] }, problems: [] };
  }
  return {
    expected: {},
    problems: [
      `the Activity Vocabulary range has ${unresolved.map((range) => JSON.stringify(range)).join(", ")}, which the namespace context gives no IRI for, so range is not checked`,
    ],
  };
};

const vocabularyFinding = (
  entry: CatalogEntry,
  definition: VocabularyDefinition | undefined,
  terms: ReadonlyMap<string, string>,
): Finding => {
  if (definition === undefined) {
    return problem(
      VOCABULARY_ORIGIN,
      "the Activity Vocabulary defines no property with this URI",
    );
  }
  const range = rangeOf(definition.range, terms);
  return {
    origin: VOCABULARY_ORIGIN,
    expected: {
      ...(definition.notes === undefined
        ? {}
        : { description: definition.notes }),
      ...range.expected,
      multiple: !definition.functional,
      source: withAnchor(entry.source, definition.anchor),
    },
    problems: [
      ...(definition.notes === undefined
        ? [
            `the Activity Vocabulary definition at #${definition.anchor} has no notes, so description is not checked`,
          ]
        : []),
      ...range.problems,
    ],
  };
};

// The definition at the entry's anchor gives its description only when it
// defines the entry's term; otherwise its text belongs to another property.
const activityPubFinding = (
  entry: CatalogEntry,
  term: NamespaceTerm,
  definition: ActivityPubDefinition | undefined,
): Finding =>
  definition === undefined
    ? problem(
        ACTIVITYPUB_ORIGIN,
        fragmentOf(entry.source) === ""
          ? "source has no fragment"
          : `ActivityPub defines nothing at #${fragmentOf(entry.source)}`,
      )
    : definition.term === term.term
      ? {
          origin: ACTIVITYPUB_ORIGIN,
          expected: { description: definition.text },
          problems: [],
        }
      : problem(
          ACTIVITYPUB_ORIGIN,
          `source points to the definition of ${definition.term}, not ${term.term}, so description is not checked`,
        );

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
  find: async (entries, documents) =>
    findingsOf(
      entries,
      findingOf({
        terms: await parseContext(
          JSON.parse(documentNamed(documents, "context")),
        ),
        namespace: parseNamespaceTerms(documentNamed(documents, "namespace")),
        vocabulary: parseVocabulary(documentNamed(documents, "vocabulary")),
        activityPub: parseActivityPub(documentNamed(documents, "activityPub")),
      }),
    ),
};
