---
links:
  '#154': https://github.com/fedify-dev/drfed/issues/154
---
 -  Added a page for each stored resource that shows its saved revisions,
    newest first, and its current revision or any earlier one read by
    meaning: the document's type, its relations grouped by property, its
    recipients, its extension properties, and the validator findings beside
    the part they concern, with embedded documents up to three levels deep.
    A reference shows its IRI and links to the resource registered under it,
    or tells that there is none you can read.  An embedded document can be
    compared with the current revision of the resource it names, which tells
    whether that resource was saved with the revision shown, changed or
    deleted after it, or never saved as the copy embedded here.  A document
    DrFed cannot interpret shows the validator findings and the saved JSON
    instead, and a deleted resource shows its deletion beside its earlier
    revisions.  The objects on an actor's page, the activity log entries of a
    stored activity, and the object just created on the object creation page
    link to the page.  [[#154]]
