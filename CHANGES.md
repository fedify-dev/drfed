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

 -  Added `@drfed/models/resource-revision` to append and read immutable
    ActivityStreams document histories. An append fails when its expected
    revision ID is stale, and object histories can end with a whiteout deletion
    marker.
    [[#150], [#164] by Hong Minhee\]
 -  Added `validateDocument()` in `@drfed/models/document` for parsed
    ActivityStreams documents. It returns structured errors and compatibility
    warnings with original nested field and list-entry paths, preserves custom
    properties as opaque JSON with warnings, and offers inspectable omission
    previews for empty addressing arrays. [[#151], [#166] by Jiwon Kwon\]
 -  Added `prepareDocument()` to compare documents with trusted server-supplied
    authority outcomes and creation values. It reports denied identities and
    server-owned-field conflicts and returns explicit generated-field changes
    with an independent preview. Permission decisions, identity allocation,
    and persistence remain the caller's responsibility.
    [[#151], [#166] by Jiwon Kwon\]
 -  Added offline validation coverage for all named activity types and selected
    Object, actor, collection, and Link types. Validation and preparation
    preserve input and perform no remote lookups, resource writes, or delivery.
    Unsupported types, properties, and context forms produce support findings;
    poll-specific rules remain separate work. The supported properties and
    representation limits are documented in *packages/models/README.md*.
    [[#151], [#166] by Jiwon Kwon\]

[#151]: https://github.com/fedify-dev/drfed/issues/151
[#166]: https://github.com/fedify-dev/drfed/pull/166


Version 0.1.0
-------------

Released on October 13, 2026.  Initial release.
