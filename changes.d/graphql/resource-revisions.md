---
links:
  '#154': https://github.com/fedify-dev/drfed/issues/154
---
 -  Added `Resource.currentRevision` and `Resource.revisions`, newest first,
    and the `ResourceRevision` node, which return the saved revisions of a
    resource, including those of resources saved without legacy details.
    Each revision returns its saved JSON, whiteout deletion details, and what
    the current validator finds in it.  When the validator reads the
    document, `root` describes it by meaning, whatever keys spell its
    properties: the relations and recipients of the root and of every
    document it embeds, with the resource currently registered under each
    IRI, and its custom extension properties.  Revisions follow the read
    rules of their resource; revisions received from elsewhere for a
    resource without legacy details are not readable yet.  Deleting a
    resource or its author hides none of its revisions.  [[#154]]
