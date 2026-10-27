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
 -  Added an offline `validateDocument()` API in `@drfed/models/document` for
    the activity base types, all named activity types, Object, Article, Note,
    the five core actor types, and collection/page types. Actor, attribution,
    location, and applicable activity relations accept references or supported
    embedded values, individually or in lists. Diagnostics retain stable
    reasons and original nested field paths. Intransitive activities reject a
    non-null object property. Question is recognized, while poll-specific
    fields remain incomplete pending their dedicated rules. Unimplemented forms
    report incomplete support. Collections check members, counts, page
    navigation, and actor collection links without fetching or changing member
    order. Link and Mention check reference metadata, dimensions, and previews.
    Type recognition uses the shared Fedify version and an explicit list
    of implemented types. Common text and language maps, actor usernames,
    timestamps, and addressing retain original values and diagnostic paths.
    Single-value properties check multiplicity while treating null entries as
    absent. Empty addressing warns and offers an explicit omission preview
    without changing the submitted document. Allowlisted bundled contexts and
    supported inline aliases retain original field/index diagnostics;
    custom properties are preserved as opaque JSON with warnings, including in
    normalization previews, without claiming to validate their semantics.
    [[#151]]

[#151]: https://github.com/fedify-dev/drfed/issues/151


Version 0.1.0
-------------

Released on October 13, 2026.  Initial release.
