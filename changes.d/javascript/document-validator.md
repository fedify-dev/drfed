 -  Added an offline `validateDocument()` API in `@drfed/models/document` for
    both activity base types, all named activity types, and Note documents.
    Travel and Question use the shared intransitive checks; poll-specific
    Question fields report incomplete support pending their dedicated rules.
    Intransitive activities report an inapplicable object property when its
    value is non-null. Location and applicable activity object, target, origin,
    result, and instrument values accepted as IRI references or supported
    embedded types, individually or in lists. Nested errors retain their
    original field paths. Diagnostics include stable reasons and field paths;
    unimplemented forms report incomplete support. Type recognition uses the
    shared Fedify vocabulary version and an explicit list of implemented types.
    [[#151]]
