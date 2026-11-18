---
links:
  '#154': https://github.com/fedify-dev/drfed/issues/154
  '#182': https://github.com/fedify-dev/drfed/pull/182
---
 -  `appendResourceRevision()` and `writeTypedResourceRevision()` in
    `@drfed/models/resource-revision` accept `embeddings`, which record the
    revision each embedded document came from and whether it keeps that
    revision's contents or was derived from it.  `commitLocalWrite()` in
    `@drfed/federation/local-write` records them for every document it saves,
    and `create` and `edit` requests accept `sources` to declare the revision
    an embedded document was loaded from.  Declaring sources requires the
    `unreadableRevisions` option of `previewLocalWrite()` and
    `commitLocalWrite()`, such as `unreadableRevisions()` of the new
    `@drfed/graphql/readable`; a source that is missing or that the member
    may not read fails alike with `source_unavailable`.
    [[#154], [#182] by Chanhaeng Lee, Hyeonseo Kim]
