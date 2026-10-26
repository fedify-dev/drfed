 -  Added an offline `validateDocument()` API in `@drfed/models/document` for
    basic Like and Create documents with actor/object IRI references and
    embedded Notes, individually or in lists, plus standalone Notes. Nested
    content errors retain their original field paths. Diagnostics include
    stable reasons and field paths; unimplemented forms report incomplete
    support. [[#151]]
