---
links:
  '#186': https://github.com/fedify-dev/drfed/issues/186
---
 -  Added `@drfed/models/known-properties`, whose `knownProperties` catalog
    gives a label, a description, and a link to the definition of each
    ActivityStreams and ActivityPub property the document checker supports and
    of the extension properties major fediverse implementations send, keyed by
    absolute property IRI.  Entries also give the declared range and whether
    multiple values are allowed when the vocabulary defines them, and looking
    up an unlisted IRI returns `undefined`.  [[#186] by ChanHaeng Lee]
