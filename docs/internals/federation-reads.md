Federation reads
================

The federation package serves local resources through the object dispatchers
in *packages/federation/src/object-dispatchers.ts* and the outbox dispatcher in
*packages/federation/src/collection.ts*.  Both read through
*packages/federation/src/serving/*, and share the SQL predicates in
*packages/federation/src/visibility.ts*, so that a resource is served the same
way wherever it is read.


Routes
------

| Route                   | Serves                                                    |
| ----------------------- | --------------------------------------------------------- |
| `/users/{actor}/{id}`   | Objects attributed to the actor, including a `Question`   |
| `/ap/creates/{id}`      | `Create` activities                                       |
| `/ap/activities/{id}`   | Every other activity, including a `Question` saved as one |
| `/users/{actor}/outbox` | The actor's published activities                          |

The common write operations allocate an IRI from the route of the resource's
type, so a route answers 404 for a resource allocated to another one.  No IRI
changes: legacy `Create` activities stay at `/ap/creates/{id}`.


Sources
-------

A `Note` or `Article` created by the `createObject` mutation, and its `Create`,
have legacy typed rows and are serialized from them by `toObject()` and
`toCreate()`, as before, also after an edit keeps the rows in step.

Every other resource, saved by the [common write operations](local-writes.md),
is served from the document of its current revision:

 -  The document is served as saved, with its context, extension properties,
    IRI references and embedded values.  An activity keeps the version it
    embedded when it was saved, so editing an object does not change an
    earlier activity's response.  Nothing is dereferenced.
 -  `bto` and `bcc` are removed from the root, from every embedded
    document, and from every JSON-LD node object in extension values, which
    a JSON-LD processor reads with the context it inherits.  They are found
    by meaning through `describeDocument()`, so aliases of them are removed
    as well; in extension values, whatever the alias's container.  JSON
    literals stay as saved, however their keywords are spelled.
 -  A document saved without `@context` states the ActivityStreams context,
    which the validator read it with and which Activity Streams 2.0 asks
    documents to include.
 -  The document must name its own resource in `id`.  Fedify does not parse
    it: the dispatchers hand Fedify a vocabulary object whose JSON-LD is the
    document, so a document with values Fedify 2.4.3 cannot read, such as a
    `Link` in `audience` or `object`, is served as saved too.
 -  A document the write path does not save, one the validator cannot read
    or one naming another resource, can only come from a change made outside
    it.  It is logged under `["drfed", "federation", "serving"]` and left
    out: its resource answers 404, and outbox pages and the counter skip it.
    Each revision is logged once per process, however often it is read,
    while it is among the last 4,096 logged.


Conditions
----------

Every read needs the request's authority to be the instance of a live local
actor, and Public `to` or `cc` addressing in the resource's current
`addressing` index.  Moreover:

 -  An activity must be in the outbox of such an actor.  A saved activity that
    was not published is not served, nor is a received one.
 -  A legacy `Create` is not served once its object is deleted.  A saved
    document is not served when the `object` of its root or of an embedded
    activity refers to a deleted local object, unless that activity is a
    `Delete`: the deletion hides the `Like` and other activities about the
    object, and an `Undo` of such a `Like`, and leaves its `Delete`
    retrievable, also inside an `Announce` that embeds it.  A local object is
    deleted when its typed row is, or when its current revision is a local
    whiteout.
 -  A saved document that embeds a deleted local object, at any depth, is
    not served, so the `Create` and `Update` activities that carried its
    content, and an `Undo` of a `Like` embedding it, are hidden.
 -  A saved document that embeds, at any depth, a document addressed to
    recipients but not to the public in its `to` or `cc` is not served,
    since its content is theirs.  Its recipients are read as the
    `addressing` index records them: references as resolved, embedded
    documents by `id`, and `Link` values by `href`.  An embedded document
    without recipients of its own goes with the document that embeds it, as
    the `Like` in an `Undo` usually does.
 -  These rules read the node objects in extension values as embedded
    documents, with their values through `@set` and `@list` objects and
    their recipients by `href` when a type is `Link`, and by `id` or else
    `href` otherwise.  A node object whose `object` refers to a deleted
    local object, by a reference or a `href`, hides the document unless its
    type is `Delete`.  A saved document is not served when a node object in
    an extension value is one `describeDocument()` leaves uninterpreted: one
    with a `@context` of its own, which the validator does not read, or with
    a value object, a language map, a string its key does not coerce to an
    IRI, or a relative reference where a reference belongs, more than one
    `id` or `href`, or properties nested by `@nest`, since its recipients
    and references cannot then be told.  Blank node identifiers are read as
    names of no resource, and language maps as strings.  Such a document is
    logged once per revision as a warning.
 -  An object must be attributed to the actor of its route by its last
    snapshot.  A deleted object is answered with `410 Gone` and a `Tombstone`
    of its `id` and `deleted` time only.

What a saved document embeds and refers to is read from the document, through
`describeDocument()`; every other condition is SQL.


Outbox
------

Outbox pages hold legacy and saved activities in one order: ascending
`position` of the outbox's `collection_items`, where the newest item has the
smallest position.  An item without a position is not listed, and its activity
is not served either.  The cursor is the position of the last item of the
previous page.

The saved activities their documents do not allow are left out after rows are
selected, so a page reads further batches until it is full, each twice as
large as the one before, up to 1,000 items.  It promises a next page only when
a served activity follows, so only the last page is short and no page is empty
while another follows.  A page after many hidden activities therefore reads
all of them.

The counter counts what the pages hold.  It reads the document of every saved
activity in the outbox on each request, 100 at a time, so its cost grows with
the outbox.  Deleted objects are looked up 1,000 IRIs at a time, below the
number of parameters PostgreSQL binds in one statement.


Outgoing payloads
-----------------

`@drfed/federation/serving` exports the same serialization for outgoing
payloads:

 -  `publicDocument(document)` returns a copy without blind recipients and
    with a stated context, or `null` for a document the validator cannot
    read offline or whose blind recipients cannot be found, as in a node
    object with a `@context` of its own in an extension value.
 -  `parseVocab(ctx, document)` parses a document into a vocabulary object
    that keeps it as its JSON-LD.  It throws for a document Fedify cannot
    read, such as one with a `Link` in `audience` or `object`.
 -  `loadActivitySnapshot(db, id)` loads a saved activity's current document,
    blind recipients included, and its revision ID, applying no condition
    above.

An object derived from a parsed one, as by `clone()`, loses that JSON-LD and is
serialized from the properties Fedify knows, without extensions.  Delivery is
not part of these reads.
