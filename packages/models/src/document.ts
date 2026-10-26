// DrFed: A web-based platform for developing and debugging ActivityPub apps
// Copyright (C) 2026 DrFed team
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import {
  type $EntityType,
  Accept,
  Activity,
  Arrive,
  Create,
  Follow,
  IntransitiveActivity,
  Like,
  Note,
  Undo,
  getEntityTypeById,
} from "@fedify/vocab";

/** The source property names and zero-based indexes leading to a finding. */
export type FieldPath = readonly (string | number)[];

export type DiagnosticCategory =
  | "vocabulary"
  | "authority"
  | "support"
  | "compatibility";

export type DiagnosticSeverity = "error" | "warning";

/** Stable classifications; human-readable diagnostic messages may change. */
export const diagnosticReasons = {
  invalid_document_root: { category: "vocabulary", severity: "error" },
  non_json_value: { category: "vocabulary", severity: "error" },
  invalid_value_shape: { category: "vocabulary", severity: "error" },
  invalid_iri: { category: "vocabulary", severity: "error" },
  invalid_datetime: { category: "vocabulary", severity: "error" },
  invalid_multiplicity: { category: "vocabulary", severity: "error" },
  property_not_applicable: { category: "vocabulary", severity: "error" },
  invalid_context: { category: "vocabulary", severity: "error" },
  context_unavailable_offline: { category: "support", severity: "error" },
  unsupported_context_form: { category: "support", severity: "error" },
  unsupported_type: { category: "support", severity: "error" },
  unsupported_property: { category: "support", severity: "error" },
  unsupported_value_form: { category: "support", severity: "error" },
  fedify_parse_failed: { category: "support", severity: "error" },
  processing_limit_exceeded: { category: "support", severity: "error" },
  diagnostic_limit_reached: { category: "support", severity: "error" },
  implicit_activitystreams_context: {
    category: "compatibility",
    severity: "warning",
  },
  extension_type_unchecked: { category: "compatibility", severity: "warning" },
  empty_addressing_list: { category: "compatibility", severity: "warning" },
  unmapped_extension_property: {
    category: "compatibility",
    severity: "warning",
  },
} as const satisfies Record<
  string,
  {
    readonly category: DiagnosticCategory;
    readonly severity: DiagnosticSeverity;
  }
>;

export type DiagnosticReason = keyof typeof diagnosticReasons;

export interface Diagnostic {
  readonly reason: DiagnosticReason;
  readonly category: DiagnosticCategory;
  readonly severity: DiagnosticSeverity;
  readonly path: FieldPath;
  readonly message: string;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A proposed transformation; validation never applies it to the input. */
export type NormalizationChange =
  | {
      readonly operation: "add";
      readonly reason: string;
      readonly path: FieldPath;
      readonly after: JsonValue;
      readonly message: string;
    }
  | {
      readonly operation: "replace";
      readonly reason: string;
      readonly path: FieldPath;
      readonly before: JsonValue;
      readonly after: JsonValue;
      readonly message: string;
    }
  | {
      readonly operation: "remove";
      readonly reason: string;
      readonly path: FieldPath;
      readonly before: JsonValue;
      readonly message: string;
    };

export interface DocumentValidationResult {
  /** Whether checks finished, including a definite invalid-input conclusion. */
  readonly complete: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly normalizedDocument?: { readonly [key: string]: JsonValue };
  readonly changes: readonly NormalizationChange[];
}

const activityStreamsContext = "https://www.w3.org/ns/activitystreams";
const activityStreamsTypePrefix = `${activityStreamsContext}#`;
const maximumDiagnostics = 100;

type Report = (
  reason: DiagnosticReason,
  path: FieldPath,
  message: string,
) => void;

// Owns diagnostic collection and completion state for one validation call.
function createReporter() {
  const diagnostics: Diagnostic[] = [];
  let complete = true;

  const report: Report = (reason, path, message) => {
    if (diagnostics.length >= maximumDiagnostics - 1) {
      complete = false;
      if (diagnostics.length < maximumDiagnostics) {
        diagnostics.push({
          reason: "diagnostic_limit_reached",
          ...diagnosticReasons.diagnostic_limit_reached,
          path: [],
          message: "Further diagnostics were omitted.",
        });
      }
      return;
    }
    const classification = diagnosticReasons[reason];
    if (classification.category === "support") complete = false;
    diagnostics.push({ reason, ...classification, path, message });
  };

  return {
    report,
    isFull: () => diagnostics.length >= maximumDiagnostics,
    result: (): DocumentValidationResult => ({
      complete,
      diagnostics,
      changes: [],
    }),
  };
}

function readDocument(
  document: unknown,
  path: FieldPath,
  report: Report,
): Record<string, unknown> | undefined {
  if (!isJsonValueShape(document)) {
    report("non_json_value", path, "Expected a JSON value.");
    return undefined;
  }
  if (
    document == null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    report("invalid_document_root", path, "Expected a document object.");
    return undefined;
  }
  const prototype: unknown = Object.getPrototypeOf(document);
  if (prototype !== Object.prototype && prototype !== null) {
    report("non_json_value", path, "Expected a plain JSON data object.");
    return undefined;
  }
  const keys = Reflect.ownKeys(document);
  if (keys.some((key) => typeof key !== "string")) {
    report(
      "non_json_value",
      path,
      "JSON objects cannot have symbol properties.",
    );
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(document);
  const values: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) {
      report(
        "non_json_value",
        [...path, key],
        "Expected an enumerable data property.",
      );
      return undefined;
    }
    const value: unknown = descriptor.value;
    if (!isJsonValueShape(value)) {
      report("non_json_value", [...path, key], "Expected a JSON value.");
      return undefined;
    }
    values[key] = value;
  }
  return values;
}

// This checks only the immediate JSON shape. Supported nested values are read
// separately through readDocument() or visitList(), without invoking accessors.
function isJsonValueShape(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "object" ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

// Reports reference-rule failures without owning the diagnostic collection.
function checkReference(value: unknown, path: FieldPath, report: Report): void {
  if (value === null) return;
  if (typeof value !== "string") {
    if (typeof value === "object") {
      report(
        "unsupported_value_form",
        path,
        "Embedded values are not checked yet.",
      );
    } else {
      report(
        "invalid_value_shape",
        path,
        "Expected a resource reference, embedded object, or allowed list.",
      );
    }
    return;
  }
  const hasControlOrSpace = Array.from(value).some((character) => {
    const point = character.codePointAt(0)!;
    return point <= 0x20 || point === 0x7f;
  });
  if (
    !value.isWellFormed() ||
    hasControlOrSpace ||
    /[<>"{}|\\^`]/u.test(value) ||
    /%(?![\da-f]{2})/iu.test(value)
  ) {
    report(
      "invalid_iri",
      path,
      "Expected a syntactically valid IRI reference.",
    );
  } else if (!/^[a-z][a-z\d+.-]*:/iu.test(value)) {
    report(
      "unsupported_value_form",
      path,
      "Relative references need a base-IRI policy.",
    );
  } else if (!URL.canParse(value)) {
    report(
      "unsupported_value_form",
      path,
      "This IRI cannot be represented by the current URL parser.",
    );
  }
}

// Applies the current list-entry policy, independently of list traversal.
function checkReferenceEntry(
  value: unknown,
  path: FieldPath,
  report: Report,
  check: typeof checkReference,
): void {
  if (!isJsonValueShape(value)) {
    report("non_json_value", path, "Expected a JSON value.");
  } else if (value === null || Array.isArray(value)) {
    report(
      "unsupported_value_form",
      path,
      "Null entries and nested lists are not checked yet.",
    );
  } else {
    check(value, path, report);
  }
}

// Visits data entries safely and constructs paths, without reference rules.
function visitList(
  values: readonly unknown[],
  path: FieldPath,
  report: Report,
  visit: (value: unknown, path: FieldPath) => void,
): void {
  if (Reflect.ownKeys(values).length > values.length + 1) {
    report(
      "non_json_value",
      path,
      "Expected a JSON array without extra properties.",
    );
    return;
  }
  for (let index = 0; index < values.length; index += 1) {
    const entryPath = [...path, index];
    const descriptor = Object.getOwnPropertyDescriptor(values, index);
    if (
      descriptor == null ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      report(
        "non_json_value",
        entryPath,
        "Expected an enumerable array entry.",
      );
      continue;
    }
    const entry: unknown = descriptor.value;
    visit(entry, entryPath);
  }
}

// Coordinates reference rules with traversal and reporting.
function checkReferenceValues(
  value: unknown,
  path: FieldPath,
  report: Report,
  check: typeof checkReference = checkReference,
  schedule: (work: () => void) => void = (work) => work(),
): void {
  if (!Array.isArray(value)) {
    schedule(() => check(value, path, report));
    return;
  }
  if (value.length === 0) {
    report(
      "unsupported_value_form",
      path,
      "Empty non-addressing lists need an agreed policy.",
    );
    return;
  }
  visitList(
    value,
    path,
    (reason, entryPath, message) =>
      schedule(() => report(reason, entryPath, message)),
    (entry, entryPath) => {
      schedule(() => checkReferenceEntry(entry, entryPath, report, check));
    },
  );
}

// A nested object inherits its parent's understood context unless it overrides it.
function checkContext(
  values: Record<string, unknown>,
  path: FieldPath,
  report: Report,
  inherited: boolean,
): boolean {
  if (!Object.hasOwn(values, "@context")) {
    if (!inherited) {
      report(
        "implicit_activitystreams_context",
        [...path, "@context"],
        "Assuming the ActivityStreams context for this document.",
      );
    }
    return true;
  }
  const context = values["@context"];
  if (
    context === activityStreamsContext ||
    context === "http://www.w3.org/ns/activitystreams"
  ) {
    return true;
  }
  const reason =
    typeof context === "string"
      ? "context_unavailable_offline"
      : context == null || typeof context === "object"
        ? "unsupported_context_form"
        : "invalid_context";
  report(
    reason,
    [...path, "@context"],
    "This context cannot be interpreted by this checker yet.",
  );
  return false;
}

// Unsupported custom types by Fedify are not in this checker's coverage.
const implementedTypes: ReadonlySet<$EntityType> = new Set<$EntityType>([
  Note,
  Activity,
  Like,
  Create,
  Undo,
  Accept,
  Follow,
  IntransitiveActivity,
  Arrive,
]);

function checkType(
  value: unknown,
  path: FieldPath,
  report: Report,
): $EntityType | undefined {
  // Context checking above ensures short type names use the ActivityStreams
  // namespace. Other context forms remain blocked before type detection.
  const typeIri =
    typeof value === "string"
      ? value.includes(":")
        ? value
        : `${activityStreamsTypePrefix}${value}`
      : undefined;
  const Type = typeIri == null ? undefined : getEntityTypeById(typeIri);
  if (Type == null || !implementedTypes.has(Type)) {
    const reason = Array.isArray(value)
      ? "unsupported_value_form"
      : value == null || typeof value === "string"
        ? "unsupported_type"
        : "invalid_value_shape";
    report(
      reason,
      [...path, "type"],
      "This type is not supported by the checker yet.",
    );
    return undefined;
  }

  return Type;
}

function checkDocumentValue(
  rootDocument: unknown,
  rootPath: FieldPath,
  reporter: ReturnType<typeof createReporter>,
): void {
  const { report, isFull } = reporter;
  const pending: (() => void)[] = [];
  const ancestors = new WeakSet<object>();

  function checkDocument(
    document: unknown,
    path: FieldPath,
    embedded: boolean,
  ): void {
    if (
      document !== null &&
      typeof document === "object" &&
      ancestors.has(document)
    ) {
      report("non_json_value", path, "JSON documents cannot contain cycles.");
      return;
    }
    const values = readDocument(document, path, report);
    if (values == null || document === null || typeof document !== "object") {
      return;
    }
    if (!checkContext(values, path, report, embedded)) return;

    const Type = checkType(values.type, path, report);
    if (Type == null) return;
    const isActivity = Type === Activity || Type.prototype instanceof Activity;
    const isIntransitive =
      Type === IntransitiveActivity ||
      Type.prototype instanceof IntransitiveActivity;

    ancestors.add(document);
    pending.push(() => {
      ancestors.delete(document);
    });
    // LIFO work preserves the same depth-first, sorted-property order.
    for (const key of Object.keys(values).sort().reverse()) {
      if (key === "@context" || key === "type") continue;
      pending.push(() => {
        const value = values[key];
        const fieldPath = [...path, key];
        if (key === "content") {
          if (value !== null && typeof value !== "string") {
            report(
              typeof value === "object"
                ? "unsupported_value_form"
                : "invalid_value_shape",
              fieldPath,
              "Expected text; language objects and content lists are not checked yet.",
            );
          }
        } else if (key === "id") {
          if (Array.isArray(value)) {
            report(
              "unsupported_value_form",
              fieldPath,
              "ID lists are not checked yet.",
            );
          } else if (value !== null && typeof value === "object") {
            report(
              "invalid_value_shape",
              fieldPath,
              "Expected an IRI identifier.",
            );
          } else {
            checkReference(value, fieldPath, report);
          }
        } else if (key === "attributedTo" || (isActivity && key === "actor")) {
          checkReferenceValues(value, fieldPath, report);
        } else if (isIntransitive && key === "object") {
          if (value !== null) {
            report(
              "property_not_applicable",
              fieldPath,
              "The object property does not apply to intransitive activities.",
            );
          }
        } else if (
          key === "location" ||
          (isActivity &&
            ["object", "target", "origin", "result", "instrument"].includes(
              key,
            ))
        ) {
          const checks: (() => void)[] = [];
          checkReferenceValues(
            value,
            fieldPath,
            report,
            (entry, entryPath) => {
              if (
                entry !== null &&
                typeof entry === "object" &&
                !Array.isArray(entry)
              ) {
                checkDocument(entry, entryPath, true);
              } else {
                checkReference(entry, entryPath, report);
              }
            },
            (check) => checks.push(check),
          );
          for (const check of checks.reverse()) pending.push(check);
        } else {
          report(
            "unsupported_property",
            fieldPath,
            "This property is not checked by the initial implementation.",
          );
        }
      });
    }
  }

  checkDocument(rootDocument, rootPath, false);
  while (pending.length > 0 && !isFull()) {
    pending.pop()!();
  }
}

/**
 * Checks Activity, IntransitiveActivity, Arrive, Like, Create, Undo, Accept,
 * Follow, and Note documents, including
 * nested activity objects, without network access or writes. Embedded objects
 * inherit the parent's context.
 *
 * Supports standard string contexts, single types, id, string content,
 * and reference-only attributedTo/actor values. Object location and activity
 * object, target,
 * origin, result, and instrument values can be IRI references or supported
 * embedded types, singly or in nonempty flat lists. Intransitive activities
 * reject a non-null object property. Other forms produce
 * support diagnostics and `complete: false`. This is not a permission check,
 * a Fedify parseability check, or full ActivityStreams validation.
 * The input must be plain JSON data, not a Proxy.
 * @returns Findings at original-input paths; no normalization is performed yet.
 */
export function validateDocument(document: unknown): DocumentValidationResult {
  const reporter = createReporter();
  checkDocumentValue(document, [], reporter);
  return reporter.result();
}
