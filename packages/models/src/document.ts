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
const maximumProperties = 10_000;
const maximumDiagnostics = 100;

type Report = (
  reason: DiagnosticReason,
  path: FieldPath,
  message: string,
) => void;

function readDocument(
  document: unknown,
  report: Report,
): Record<string, unknown> | undefined {
  if (!isJsonValueShape(document)) {
    report("non_json_value", [], "Expected a JSON value.");
    return undefined;
  }
  if (
    document == null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    report("invalid_document_root", [], "Expected a document object.");
    return undefined;
  }
  const prototype: unknown = Object.getPrototypeOf(document);
  if (prototype !== Object.prototype && prototype !== null) {
    report("non_json_value", [], "Expected a plain JSON data object.");
    return undefined;
  }
  const keys = Reflect.ownKeys(document);
  if (keys.length > maximumProperties) {
    report("processing_limit_exceeded", [], "Too many document properties.");
    return undefined;
  }
  if (keys.some((key) => typeof key !== "string")) {
    report("non_json_value", [], "JSON objects cannot have symbol properties.");
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(document);
  const values: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) {
      report("non_json_value", [key], "Expected an enumerable data property.");
      return undefined;
    }
    const value: unknown = descriptor.value;
    if (!isJsonValueShape(value)) {
      report("non_json_value", [key], "Expected a JSON value.");
      return undefined;
    }
    values[key] = value;
  }
  return values;
}

// Nested values are unsupported in this first slice, so this checks only the
// immediate JSON shape and never reads a nested property or invokes an accessor.
function isJsonValueShape(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "object" ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function checkReference(value: unknown, path: FieldPath, report: Report): void {
  if (value === null) return;
  if (typeof value !== "string") {
    if (typeof value === "object") {
      report(
        "unsupported_value_form",
        path,
        "Lists and embedded values are not checked yet.",
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

/**
 * Checks the initial Like/reference subset without network access or writes.
 *
 * Only standard string contexts, a single Like type, and optional actor/object
 * IRI references are implemented. Other fields, types, lists, and embedded
 * values produce support diagnostics and `complete: false`. This is not a
 * permission check, a Fedify parseability check, or full ActivityStreams
 * validation. The input must be plain JSON data, not a Proxy.
 * @returns Findings at original-input paths; no normalization is performed yet.
 */
export function validateDocument(document: unknown): DocumentValidationResult {
  const diagnostics: Diagnostic[] = [];
  let complete = true;

  function report(reason: DiagnosticReason, path: FieldPath, message: string) {
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
  }

  function result(): DocumentValidationResult {
    return { complete, diagnostics, changes: [] };
  }

  const values = readDocument(document, report);
  if (values == null) return result();

  if (!Object.hasOwn(values, "@context")) {
    report(
      "implicit_activitystreams_context",
      ["@context"],
      "Assuming the ActivityStreams context for this document.",
    );
  } else if (
    values["@context"] !== activityStreamsContext &&
    values["@context"] !== "http://www.w3.org/ns/activitystreams"
  ) {
    const context = values["@context"];
    const reason =
      typeof context === "string"
        ? "context_unavailable_offline"
        : context == null || typeof context === "object"
          ? "unsupported_context_form"
          : "invalid_context";
    report(
      reason,
      ["@context"],
      "This context cannot be interpreted by this checker yet.",
    );
    return result();
  }

  if (
    values.type !== "Like" &&
    values.type !== `${activityStreamsTypePrefix}Like`
  ) {
    const reason = Array.isArray(values.type)
      ? "unsupported_value_form"
      : values.type == null || typeof values.type === "string"
        ? "unsupported_type"
        : "invalid_value_shape";
    report(
      reason,
      ["type"],
      "This initial checker supports a single Like type.",
    );
    return result();
  }

  for (const key of Object.keys(values).sort()) {
    if (key === "@context" || key === "type") continue;
    if (diagnostics.length >= maximumDiagnostics) break;
    if (key !== "actor" && key !== "object") {
      report(
        "unsupported_property",
        [key],
        "This property is not checked by the initial implementation.",
      );
      continue;
    }
    checkReference(values[key], [key], report);
  }
  return result();
}
