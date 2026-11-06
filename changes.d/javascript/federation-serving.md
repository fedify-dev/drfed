---
links:
  '#153': https://github.com/fedify-dev/drfed/issues/153
---
 -  Added the `@drfed/federation/serving` subpath.  It exports
    `publicDocument()`, the serialization federation reads use for saved
    documents, `parseVocab()`, which parses such a document into a Fedify
    vocabulary object, and `loadActivitySnapshot()`.
    [[#153] by ChanHaeng Lee]

 -  Added `extensions` to the nodes `describeDocument()` in
    `@drfed/models/document` returns: the JSON-LD node objects in their
    extension values, with the standard properties their keys stand for and
    their IRI references.
    [[#153] by ChanHaeng Lee]
