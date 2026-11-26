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
lists the types and datatypes the vocabulary declares, and `multiple` says
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
    context's `@type` coercion or a parser's behavior.
 -  Link `source` to the definition, or, when there is none, to the
    implementation's federation documentation or source.

The build validates the file against *src/properties.schema.yaml*
and fails on duplicate keys, keys that are not absolute IRIs, and missing
English text.  The published package contains the validated data only, not the
YAML files or a YAML parser.


Namespace checks
----------------

`node packages/vocab/tools/check.mts` fetches what the namespaces of the
entries publish and compares the entries with it, and
`mise run update:known-properties` writes the values they give into
*src/properties.yaml*, rewriting only the lines of the fields it changes.  Both
need network access.  The update lists what no value can fix, such as an IRI
that its namespace does not define, and leaves a field alone when two
namespaces give different values for it.  Each namespace is listed in
*tools/namespaces.mts* with the kind that reads what it publishes:

 -  Activity Streams: every entry whose `source` is the Activity Vocabulary or
    ActivityPub, including `ldp:inbox`, is read from
    <https://www.w3.org/ns/activitystreams> and the definitions it links its
    terms to.  The IRI must be a property term of the namespace, and the
    definition gives `description`.  An Activity Vocabulary definition also
    gives `range`, `multiple`, and the anchor of `source`.
 -  A JSON-LD context, such as GoToSocial's: a term of the context must expand
    to the entry's IRI.  It gives no values.
 -  An RDF vocabulary in JSON-LD or Turtle, such as vCard: the vocabulary must
    define the IRI.  An `rdfs:range` gives `range`, and an
    `owl:FunctionalProperty` gives `multiple: false`.
 -  An HTML page that documents each term under an anchor, such as Misskey's:
    `source` must point to an anchor of the page.  It gives no values.

To check another namespace, add it to that list.  The check prints the
namespaces of the entries that no listed namespace covers.
