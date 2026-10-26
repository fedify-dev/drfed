 -  Added an offline `validateDocument()` API in `@drfed/models/document` for
    Like, Create, Undo, Accept, Follow, and Note documents, with activity object
    values accepted as IRI references or supported embedded types, individually
    or in lists. Nested
    content errors retain their original field paths. Diagnostics include
    stable reasons and field paths; unimplemented forms report incomplete
    support. [[#151]]
