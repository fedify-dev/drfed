---
links:
  '#152': https://github.com/fedify-dev/drfed/issues/152
  '#173': https://github.com/fedify-dev/drfed/pull/173
---
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
    [[#152], [#173] by Hong Minhee]

 -  Added `createLegacyObject()` to `@drfed/federation/local-write`, the
    operation behind the `createObject` mutation, which creates a Note or
    Article with a `Create` in the outbox as before.
    [[#152], [#173] by Hong Minhee]

 -  Added `describeDocument()` to `@drfed/models/document`, which describes a
    valid document's embedded documents, the standard properties their keys
    stand for, and their IRI references with compact IRIs expanded, as the
    validator reads them.
    [[#152], [#173] by Hong Minhee]

 -  Added `writeTypedResourceRevision()` to `@drfed/models/resource-revision`
    to edit or delete an object that has a legacy typed row while keeping the
    row and its history in step. Revision appends and the new
    `storeAddressingOccurrences()` and `replaceAddressing()` in
    `@drfed/models/resource` also accept addressing occurrences with their
    source positions.
    [[#152], [#173] by Hong Minhee]
