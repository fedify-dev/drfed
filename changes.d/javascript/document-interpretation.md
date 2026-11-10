---
links:
  '#154': https://github.com/fedify-dev/drfed/issues/154
---
 -  Added the `@drfed/federation/document` subpath.  Its
    `interpretDocument()` returns every vocabulary document of a saved
    document with its relations, recipients, and custom extension
    properties, read by meaning as the validator reads them.  [[#154]]

 -  Added `extensionProperties` to the nodes `describeDocument()` in
    `@drfed/models/document` returns: the source keys of each document's
    custom extension properties.  [[#154]]
