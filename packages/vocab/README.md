@drfed/vocab
============

Vocabulary metadata for [DrFed]: what the properties of ActivityStreams,
ActivityPub, and the extensions fediverse implementations send mean, keyed by
absolute property IRI, with the tools that check it against what the
vocabularies publish.

[DrFed]: https://drfed.org/


Known properties
----------------

`@drfed/vocab/known-properties`, also exported from `@drfed/vocab`, exports
`knownProperties`, a catalog of property metadata for the structured editors
(#140), with the `KnownProperty`, `KnownProperties`, and `LocalizedText`
types.  Entries are keyed by absolute property IRI, so a lookup needs neither a
document context nor a Fedify schema:

~~~~ ts
import { knownProperties } from "@drfed/vocab/known-properties";

const actor = knownProperties["https://www.w3.org/ns/activitystreams#actor"];
console.log(actor?.label.en); // "Actor"
~~~~

Each entry has a `label` and a `description` keyed by language tag, always
with English text, and a `source` link to the property's definition.  `range`
lists the types and datatypes the vocabulary declares, a value being one of
them, and `multiple` says
whether it allows more than one value; both are absent when the vocabulary
does not say, and an absent `multiple` does not mean single-valued.  Terms
that share a label but expand to different IRIs are separate entries.

The catalog is not a validation rule.  An unlisted IRI returns `undefined`,
which only means there is no metadata for it, and a listed entry does not mean
that the document checker accepts every value its range allows.  The catalog
holds the properties the checker has rules for and the extension properties
that Mastodon, Misskey, GoToSocial, Pleroma, Akkoma, Lemmy, PieFed, Mbin,
Pixelfed, and Loops send.  The object and its entries are frozen, and the
object has no prototype.

To add or change an entry, edit *src/properties.yaml*:

 -  Key the entry by the IRI the vocabulary's context produces, written out in
    full.  For an implementation's extension, that is the IRI its own
    `@context` produces, which can differ from what a specification suggests.
 -  Take `range` and `multiple` only from a formal definition, not from a
    context's `@type` coercion or a parser's behavior.  A vocabulary that
    only suggests types, as schema.org and Dublin Core do with
    `rangeIncludes`, gives all of them, even those that implementations do
    not send; `range` does not tell a stated range from a suggested one.
 -  For a property the Activity Vocabulary or ActivityPub defines, keep the
    definition's text in `description` as it is written, including its
    citations and errors; `mise run update:known-properties` writes it.
 -  Link `source` to the definition, or, when there is none, to the
    implementation's federation documentation or source.

The build validates the file against *src/properties.schema.yaml*
and fails on duplicate keys, keys that are not absolute IRIs, and missing
English text.  `@drfed/vocab/known-properties` contains the validated data
only, not the YAML files or a YAML parser.


Namespace checks
----------------

`mise run check:known-properties` fetches what the namespaces of the
entries publish and compares the entries with it, and
`mise run update:known-properties` writes the values they give into
*src/properties.yaml*, rewriting only the lines of the fields it changes.  Both
need network access, and retry a request three times when it fails for a
network problem: its connection fails or breaks, it times out, or it is
answered 408, 429, 500, 502, 503, or 504.  A namespace whose documents still
cannot be fetched is skipped; the check warns with their URLs and passes, and
the update lists them as left for a person to resolve.  Any other failure, such
as a URL that is not HTTP or HTTPS, fails the namespace.  The update lists what
no value can fix, such as an IRI that its namespace does not define, and leaves
a field alone when two namespaces give different values for it, even when the
entry has one of them.  It writes nothing when the result would not pass the
schema.  Each namespace is listed in *tools/namespaces.mts* with the kind that
reads what it publishes:

 -  Activity Streams: every entry whose `source` is the Activity Vocabulary or
    ActivityPub, including `ldp:inbox`, is read from
    <https://www.w3.org/ns/activitystreams> and the definitions it links its
    terms to.  The IRI must be a property term of the namespace, and the
    definition gives `description`, unless `source` points to the definition
    of another term.  An Activity Vocabulary definition also gives
    `multiple`, the anchor of `source`, and `range`: the IRIs of its types,
    an ordered list of them read as its members, or none when the range is
    only prose such as `MIME Media Type`.  A range with a type the context
    gives no IRI for, or with prose beside types, is reported and not
    checked.
 -  A JSON-LD context, such as GoToSocial's: a term of the context must expand
    to the entry's IRI.  It gives no values.
 -  An RDF vocabulary in JSON-LD or Turtle, such as vCard: the vocabulary must
    define the IRI.  An `rdfs:range` gives `range`, and without one, every type
    that `schema:rangeIncludes` or `dcam:rangeIncludes` suggests does.  An
    `owl:FunctionalProperty` gives `multiple: false`.  A `range` or a
    `multiple: false` of an entry that the vocabulary does not declare is
    reported, never removed, unless the namespace's `definedElsewhere` lists
    it, as for the range ActivityPub gives `ldp:inbox`.
 -  An HTML page that documents each term under an anchor, such as Misskey's:
    `source` must point to an anchor of the page.  It gives no values.

To check another namespace, add it to that list.  The check prints the
namespaces of the entries that no listed namespace covers, and a comment in
the same file records why each of them cannot be checked: some IRIs are
identifiers that were never meant to resolve, and others answer 404.

The check fails when a namespace changes what it publishes, such as the text
of a definition or the anchor of a term, even on a pull request that does not
touch the catalog.  This is deliberate: the catalog follows its namespaces, and
a difference means the catalog no longer does.  Resolve such a failure before
other work, with `mise run update:known-properties` or by changing the entry or
the namespace list, and commit the result as a change of its own.

Besides the two commands, that list, and the catalog paths they share,
*tools/* holds what the commands run, tested next to it: the parsers of what
namespaces publish, the kinds of namespace above, `collectReports()`, which
fetches with the retries above and takes a `fetch` and a `sleep` to use instead
of the global ones, `summarizeReports()`, which decides what the check prints
and whether it passes, `planUpdate()`, and `updateCatalog()`, which rewrites
the catalog's text.  None of these modules reads or writes a file or loads a
remote JSON-LD context.  *tools/* is not published, so the parsers it uses
stay development dependencies.
