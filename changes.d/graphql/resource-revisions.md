---
links:
  '#154': https://github.com/fedify-dev/drfed/issues/154
  '#182': https://github.com/fedify-dev/drfed/pull/182
---
 -  Added `Resource.currentRevision`, `Resource.revisions`, newest first,
    `Resource.revision(sequence:)`, and the `ResourceRevision` node, which
    return the saved revisions of a resource, including those of resources
    saved without legacy details.
    Each revision returns its saved JSON, whiteout deletion details, and what
    the current validator finds in it.  When the validator reads the
    document, `root` describes it by meaning, whatever keys spell its
    properties: the relations and recipients of the root and of every
    document it embeds, with the resource currently registered under each
    IRI, and its custom extension properties.  Each revision is read by
    evidence of its own: local revisions by anyone, revisions addressed to the
    public by anyone, and received revisions by members of the instance that
    received them.  Administrators read every revision, and the current
    revision of a resource with legacy details is also readable to whoever
    may read those details.  `DocumentNode.source` tells which revision an
    embedded document came from, whether it keeps that revision's contents or
    was derived from it, and whether that revision is still current,
    superseded, or deleted; it is null when the viewer may not read that
    revision, and the embedded document itself stays readable.  Deleting a
    resource or its author hides none of its revisions by itself.  A `Resource`
    is returned by `node`, `Activity.object`, and relations and recipients
    whenever the viewer may read one of its revisions, even after its current
    state was restricted, while `Resource.detail` and the typed node stay
    hidden. `Actor.objects` takes a `filter` whose `includeDeleted` lists
    deleted objects too, and `Object.deleted` tells when one was deleted.
    [[#154], [#182] by Chanhaeng Lee, Hyeonseo Kim]
