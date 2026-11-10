DrFed changelog
===============

Version 0.2.0
-------------

To be released.

### DrFed

 -  Activities and objects saved by the common write operations are now
    served over ActivityPub as they were saved, with their extension
    properties and without blind recipients, also inside extension values.
    Published activities of every type appear in the actor's outbox beside
    existing `Create` activities. Earlier activities keep the versions they
    embedded after an edit.  A deleted object is answered with a `Tombstone`,
    and its `Delete` is the only activity about it that remains retrievable.  A
    Public activity that embeds content addressed to particular recipients,
    even inside an extension value, is not served. Existing IRIs do not change.
    [[#153], [#177] by ChanHaeng Lee\]
 -  Added immutable document histories for local object creation and accepted
    incoming Create activities. Database upgrades retain existing object and
    activity documents, including those of deleted objects. Back up and stop
    DrFed before running `drfed-migrate`.  [[#150], [#164] by Hong Minhee\]
 -  Changed <https://drfed.org/> to serve the DrFed documentation for the
    highest released version, prereleases included, along with a changelog
    page. Documentation for the development version is available at
    <https://canary.drfed.org/>.  [[#134], [#137] by ChanHaeng Lee\]
 -  Published the official container image `ghcr.io/fedify-dev/drfed` for
    `linux/amd64` and `linux/arm64`, with all four commands, along with
    installation guides for Docker, Podman, and other container tools and
    Compose examples for PGlite and PostgreSQL. Inside the image,
    `drfed-server` and `drfed-web` listen on `0.0.0.0` by default; any
    configured listen address still takes precedence.
    [[#135], [#167] by ChanHaeng Lee\]

[#134]: https://github.com/fedify-dev/drfed/issues/134
[#135]: https://github.com/fedify-dev/drfed/issues/135
[#137]: https://github.com/fedify-dev/drfed/pull/137
[#150]: https://github.com/fedify-dev/drfed/issues/150
[#153]: https://github.com/fedify-dev/drfed/issues/153
[#164]: https://github.com/fedify-dev/drfed/pull/164
[#167]: https://github.com/fedify-dev/drfed/pull/167
[#177]: https://github.com/fedify-dev/drfed/pull/177

### GraphQL APIs

 -  Added `Resource.currentRevision` and `Resource.revisions`, newest first,
    and the `ResourceRevision` node, which return the saved revisions of a
    resource, including those of resources saved without legacy details.
    Each revision returns its saved JSON, whiteout deletion details, and what
    the current validator finds in it.  When the validator reads the
    document, `root` describes it by meaning, whatever keys spell its
    properties: the relations and recipients of the root and of every
    document it embeds, with the resource currently registered under each
    IRI, and its custom extension properties.  Revisions follow the read
    rules of their resource; revisions received from elsewhere for a
    resource without legacy details are not readable yet.  Deleting a
    resource or its author hides none of its revisions.  [[#154]]
 -  Fixed `Resource.detail` to return `null` without a field error when the
    resource has no corresponding detail record.
    [[#150], [#164] by Hong Minhee\]

[#154]: https://github.com/fedify-dev/drfed/issues/154

### JavaScript/TypeScript APIs

 -  Added `@drfed/federation/local-write`, the common write operations for
    local resources. `previewLocalWrite()` shows every value the server adds,
    including new IRIs, timestamps, and generated activities, and returns a
    token; `commitLocalWrite()` saves exactly those values after checking
    permission again, all or nothing. It saves an object alone, an activity
    that refers to existing resources or IRIs, or an activity with new nested
    objects or activities, and commits actual edits and deletions of current
    objects with a generated `Update` or `Delete`. Saving never delivers
    anything; publishing, editing, and deleting add an activity to the outbox
    and require a dispatch reservation from the caller.
    [[#152], [#173] by Hong Minhee\]
 -  Added `createLegacyObject()` to `@drfed/federation/local-write`, the
    operation behind the `createObject` mutation, which creates a Note or
    Article with a `Create` in the outbox as before, and
    `isLocalWriteError()`, which tells the error it returns from the object
    it creates.
    [[#152], [#173] by Hong Minhee\]
 -  Added `describeDocument()` to `@drfed/models/document`, which describes a
    valid document's embedded documents, the standard properties their keys
    stand for, and their IRI references with compact IRIs expanded, as the
    validator reads them.
    [[#152], [#173] by Hong Minhee\]
 -  Added `writeTypedResourceRevision()` to `@drfed/models/resource-revision`
    to edit or delete an object that has a legacy typed row while keeping the
    row and its history in step. Revision appends and the new
    `storeAddressingOccurrences()` and `replaceAddressing()` in
    `@drfed/models/resource` also accept addressing occurrences with their
    source positions.
    [[#152], [#173] by Hong Minhee\]
 -  Added `@drfed/models/resource-revision` to append and read immutable
    ActivityStreams document histories. An append fails when its expected
    revision ID is stale, and object histories can end with a whiteout deletion
    marker.
    [[#150], [#164] by Hong Minhee\]
 -  Added the `@drfed/federation/document` subpath.  Its
    `interpretDocument()` returns every vocabulary document of a saved
    document with its relations, recipients, and custom extension
    properties, read by meaning as the validator reads them.  [[#154]]
 -  Added `extensionProperties` to the nodes `describeDocument()` in
    `@drfed/models/document` returns: the source keys of each document's
    custom extension properties.  [[#154]]
 -  Added the `@drfed/federation/serving` subpath.  It exports
    `publicDocument()`, the serialization federation reads use for saved
    documents, `parseVocab()`, which parses such a document into a Fedify
    vocabulary object, and `loadActivitySnapshot()`.
    [[#153], [#177] by ChanHaeng Lee\]
 -  Added `extensions` to the nodes `describeDocument()` in
    `@drfed/models/document` returns: the JSON-LD node objects in their
    extension values, with the standard properties their keys stand for,
    their types and their IRI references.
    [[#153], [#177] by ChanHaeng Lee\]
 -  Added `validateDocument()` in `@drfed/models/document` for parsed
    ActivityStreams documents. It returns structured errors and compatibility
    warnings with original nested field and list-entry paths, preserves custom
    properties as opaque JSON with warnings, and offers inspectable omission
    previews for empty arrays on supported properties and absent identifiers.
    [[#151], [#166] by Jiwon Kwon\]
 -  Added `prepareDocument()` to compare documents with trusted server-supplied
    authority outcomes and creation values. It reports denied identities and
    server-owned-field conflicts and returns explicit generated-field changes
    with an independent preview. Permission decisions, identity allocation,
    and persistence remain the caller's responsibility.
    [[#151], [#166] by Jiwon Kwon\]
 -  Added offline validation coverage for all named activity types and selected
    Object, actor, collection, and Link types. Validation and preparation
    preserve input and perform no remote lookups, resource writes, or delivery.
    Embedded document and extension traversal is limited to 64 path segments;
    deeper values produce a support error and an incomplete result.
    Unsupported types, properties, and context forms produce support findings;
    poll-specific rules remain separate work. The supported properties and
    representation limits are documented in *packages/models/README.md*.
    [[#151], [#166] by Jiwon Kwon\]

[#151]: https://github.com/fedify-dev/drfed/issues/151
[#152]: https://github.com/fedify-dev/drfed/issues/152
[#166]: https://github.com/fedify-dev/drfed/pull/166
[#173]: https://github.com/fedify-dev/drfed/pull/173


Version 0.1.0
-------------

Released on October 13, 2026. Initial release.
