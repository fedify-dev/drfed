---
links:
  '#153': https://github.com/fedify-dev/drfed/issues/153
  '#177': https://github.com/fedify-dev/drfed/pull/177
---
 -  Activities and objects saved by the common write operations are now
    served over ActivityPub as they were saved, with their extension
    properties and without blind recipients, also inside extension values.
    Published activities of every type appear in the actor's outbox beside
    existing `Create` activities. Earlier activities keep the versions they
    embedded after an edit.  A deleted object is answered with a `Tombstone`,
    and its `Delete` is the only activity about it that remains retrievable.  A
    Public activity that embeds content addressed to particular recipients,
    even inside an extension value, is not served. Existing IRIs do not change.
    [[#153], [#177] by ChanHaeng Lee]
