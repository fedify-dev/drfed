---
links:
  '#155': https://github.com/fedify-dev/drfed/issues/155
  '#185': https://github.com/fedify-dev/drfed/pull/185
---
 -  Added poll validation to `validateDocument()` in `@drfed/models/document`:
    `Question` documents support single- or multiple-answer choices and
    boolean/date-time closing conditions. Supplying both choice modes reports
    `mutually_exclusive_properties` at the original fields. Supported choice
    content and custom extensions are retained during validation.
    [[#155], [#185]]
