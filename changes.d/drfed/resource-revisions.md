---
links:
  '#150': https://github.com/fedify-dev/drfed/issues/150
  '#164': https://github.com/fedify-dev/drfed/pull/164
---
 -  Added immutable document histories for local object creation and accepted
    incoming Create activities. Database upgrades retain existing object and
    activity documents, including those of deleted objects. Back up and stop
    DrFed before running `drfed-migrate`.  [[#150], [#164] by Hong Minhee]
