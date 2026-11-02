DrFed changelog
===============

Version 0.2.0
-------------

To be released.

### DrFed

 -  Added immutable document histories for local object creation and accepted
    incoming Create activities. Database upgrades retain existing object and
    activity documents, including those of deleted objects. Back up and stop
    DrFed before running `drfed-migrate`.  [[#150], [#164] by Hong Minhee\]
 -  Changed <https://drfed.org/> to serve the DrFed documentation for the
    highest released version, prereleases included, along with a changelog
    page. Documentation for the development version is available at
    <https://canary.drfed.org/>.  [[#134], [#137] by ChanHaeng Lee\]

[#134]: https://github.com/fedify-dev/drfed/issues/134
[#137]: https://github.com/fedify-dev/drfed/pull/137
[#150]: https://github.com/fedify-dev/drfed/issues/150
[#164]: https://github.com/fedify-dev/drfed/pull/164

### GraphQL APIs

 -  Fixed `Resource.detail` to return `null` without a field error when the
    resource has no corresponding detail record.
    [[#150], [#164] by Hong Minhee\]

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
    Article with a `Create` in the outbox as before.
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

Released on October 13, 2026.  Initial release.
