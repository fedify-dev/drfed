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
    arbitrary custom properties remain explicitly unsupported. [[#151]]
