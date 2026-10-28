---
links:
  '#150': https://github.com/fedify-dev/drfed/issues/150
  '#164': https://github.com/fedify-dev/drfed/pull/164
---
 -  Added `@drfed/models/resource-revision` to append and read immutable
    ActivityStreams document histories. An append fails when its expected
    revision ID is stale, and object histories can end with a whiteout deletion
    marker.
    [[#150], [#164] by Hong Minhee]
