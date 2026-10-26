 -  Added an offline `validateDocument()` API in `@drfed/models/document` for
    Activity, IntransitiveActivity, Arrive, Like, Create, Undo, Accept, Follow,
    and Note documents. Intransitive activities report an inapplicable object
    property when its value is non-null. Location and applicable activity
    object, target, origin, result, and instrument values accepted as IRI
    references or supported embedded types, individually or in lists. Nested
    errors retain their original field paths. Diagnostics include stable
    reasons and field paths; unimplemented forms report incomplete support.
    Type recognition uses the shared Fedify vocabulary version and an explicit
    list of implemented types. [[#151]]
