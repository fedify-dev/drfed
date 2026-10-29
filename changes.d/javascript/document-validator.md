---
links:
  '#151': https://github.com/fedify-dev/drfed/issues/151
  '#166': https://github.com/fedify-dev/drfed/pull/166
---
 -  Added `validateDocument()` in `@drfed/models/document` for parsed
    ActivityStreams documents. It returns structured errors and compatibility
    warnings with original nested field and list-entry paths, preserves custom
    properties as opaque JSON with warnings, and offers inspectable omission
    previews for empty addressing arrays. [[#151], [#166] by Jiwon Kwon]

 -  Added `prepareDocument()` to compare documents with trusted server-supplied
    authority outcomes and creation values. It reports denied identities and
    server-owned-field conflicts and returns explicit generated-field changes
    with an independent preview. Permission decisions, identity allocation,
    and persistence remain the caller's responsibility.
    [[#151], [#166] by Jiwon Kwon]

 -  Added offline validation coverage for all named activity types and selected
    Object, actor, collection, and Link types. Validation and preparation
    preserve input and perform no remote lookups, resource writes, or delivery.
    Unsupported types, properties, and context forms produce support findings;
    poll-specific rules remain separate work. The supported properties and
    representation limits are documented in *packages/models/README.md*.
    [[#151], [#166] by Jiwon Kwon]
