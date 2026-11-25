---
links:
  '#187': https://github.com/fedify-dev/drfed/issues/187
---
 -  Added `@drfed/models/expansion`, whose `expandDocument()` expands a
    document with the JSON-LD processor Fedify uses, reading only preloaded
    and given contexts, and reports the terms it dropped or kept as blank node
    identifiers.  Appending a revision through
    `@drfed/models/resource-revision` now records its expansion, which
    `loadRevisionExpansion()` reads; snapshots accept a precomputed
    `expansion`, and an embedded snapshot requires one.
    [[#187] by Hyeonseo Kim]

 -  Added `gatherContexts()` and `expandGathered()` to
    `@drfed/federation/expansion`, which gather a document's remote contexts
    before a transaction and expand it from them inside one, and
    `backfillExpansions()` to `@drfed/federation/expansion-backfill`, whose
    `retryFailed` option expands failed revisions again.
    [[#187] by Hyeonseo Kim]
