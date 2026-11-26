@drfed/vocab
============

Tools that check the known property catalog of [DrFed], kept in
*packages/models/src/vocabulary/properties.yaml*, against what the
vocabularies of its entries publish, and that update the catalog from them.

[DrFed]: https://drfed.org/


Namespace checks
----------------

`node packages/vocab/tools/check.mts` fetches what the namespaces of the
entries publish and compares the entries with it, and
`mise run update:known-properties` writes the values they give into the
catalog, rewriting only the lines of the fields it changes.  Both need network
access.  The update lists what no value can fix, such as an IRI that its
namespace does not define, and leaves a field alone when two namespaces give
different values for it.  Each namespace is listed in *tools/namespaces.mts*
with the kind that reads what it publishes:

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
