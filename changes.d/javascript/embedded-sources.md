---
links:
  '#154': https://github.com/fedify-dev/drfed/issues/154
---
 -  `appendResourceRevision()` and `writeTypedResourceRevision()` in
    `@drfed/models/resource-revision` accept `embeddings`, which record the
    revision each embedded document came from and whether it keeps that
    revision's contents or was derived from it.  `commitLocalWrite()` in
    `@drfed/federation/local-write` records them for every document it saves,
    and `create` and `edit` requests accept `sources` to declare the revision
    an embedded document was loaded from.  [[#154]]
