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

import { MIMEType } from "node:util";

import {
  type $EntityType,
  Object as APObject,
  Accept,
  Activity,
  Add,
  Announce,
  Application,
  Arrive,
  Article,
  Block,
  Collection,
  CollectionPage,
  Create,
  Delete,
  Dislike,
  Flag,
  Follow,
  Group,
  Ignore,
  IntransitiveActivity,
  Invite,
  Join,
  Leave,
  Like,
  Link,
  Listen,
  Mention,
  Move,
  Note,
  Offer,
  OrderedCollection,
  OrderedCollectionPage,
  Organization,
  Person,
  Question,
  Read,
  Reject,
  Remove,
  Service,
  TentativeAccept,
  TentativeReject,
  Travel,
  Undo,
  Update,
  View,
  getEntityTypeById,
} from "@fedify/vocab";
import { preloadedContexts } from "@fedify/vocab-runtime";

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
  unauthorized_local_identity: { category: "authority", severity: "error" },
  server_owned_field_conflict: { category: "authority", severity: "error" },
  context_unavailable_offline: { category: "support", severity: "error" },
  unsupported_context_form: { category: "support", severity: "error" },
  unsupported_type: { category: "support", severity: "error" },
  unsupported_property: { category: "support", severity: "error" },
  unsupported_value_form: { category: "support", severity: "error" },
  diagnostic_limit_reached: { category: "support", severity: "error" },
  implicit_activitystreams_context: {
    category: "compatibility",
    severity: "warning",
  },
  extension_property_unchecked: {
    category: "compatibility",
    severity: "warning",
  },
  empty_property_list: { category: "compatibility", severity: "warning" },
  absent_identifier: { category: "compatibility", severity: "warning" },
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

/** A permission outcome established by server code, not by document content. */
export interface DocumentAuthority {
  readonly allowed: boolean;
  /** Original document location; use [] for an operation-level denial. */
  readonly path: FieldPath;
}

/** An authoritative creation value allocated by the caller, never the editor. */
export interface ServerOwnedField {
  /** Source path to id, actor, attributedTo, published, or updated. */
  readonly path: FieldPath;
  readonly value: string;
}

/** Trusted server inputs; these options must not be accepted from a client. */
export interface DocumentPreparationOptions {
  /** At least one explicit outcome is required; omission never means allowed. */
  readonly authority: readonly [DocumentAuthority, ...DocumentAuthority[]];
  readonly serverOwnedFields: readonly ServerOwnedField[];
}

const activityStreamsContext = "https://www.w3.org/ns/activitystreams";
const maximumDiagnostics = 100;
const actorTypes = [Application, Group, Organization, Person, Service];
const addressingProperties = ["to", "cc", "bto", "bcc", "audience"];
// AS2 vocabulary Object properties that do not also apply to Link.
const objectOnlyProperties: ReadonlySet<string> = new Set([
  "attachment",
  "attributedTo",
  "audience",
  "content",
  "contentMap",
  "context",
  "endTime",
  "generator",
  "icon",
  "image",
  "inReplyTo",
  "location",
  "published",
  "replies",
  "startTime",
  "summary",
  "summaryMap",
  "tag",
  "updated",
  "url",
  "to",
  "bto",
  "cc",
  "bcc",
  "duration",
]);

type Report = (
  reason: DiagnosticReason,
  path: FieldPath,
  message: string,
) => void;

type VocabularyType = $EntityType | typeof Link | typeof Mention;

// Unsupported custom types by Fedify are not in this checker's coverage.
const implementedTypes: ReadonlySet<VocabularyType> = new Set<VocabularyType>([
  Note,
  APObject,
  Article,
  Application,
  Group,
  Organization,
  Person,
  Service,
  Collection,
  OrderedCollection,
  CollectionPage,
  OrderedCollectionPage,
  Link,
  Mention,
  Activity,
  Like,
  Create,
  Undo,
  Accept,
  Follow,
  IntransitiveActivity,
  Arrive,
  Travel,
  Add,
  Announce,
  Block,
  Delete,
  Dislike,
  Flag,
  Ignore,
  Invite,
  Join,
  Leave,
  Listen,
  Move,
  Offer,
  Question,
  Read,
  Reject,
  Remove,
  TentativeAccept,
  TentativeReject,
  Update,
  View,
]);

// Owns diagnostic collection and completion state for one validation call.
function createReporter() {
  const diagnostics: Diagnostic[] = [];
  let complete = true;
  let truncated = false;

  const report: Report = (reason, path, message) => {
    if (truncated) return;
    if (diagnostics.length === maximumDiagnostics) {
      complete = false;
      truncated = true;
      diagnostics[maximumDiagnostics - 1] = {
        reason: "diagnostic_limit_reached",
        ...diagnosticReasons.diagnostic_limit_reached,
        path: [],
        message: "Further diagnostics were omitted.",
      };
      return;
    }
    const classification = diagnosticReasons[reason];
    if (classification.category === "support") complete = false;
    diagnostics.push({ reason, ...classification, path, message });
  };

  return {
    report,
    isFull: () => truncated,
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
  if (value === null) return;
  if (!isJsonValueShape(value)) {
    report("non_json_value", path, "Expected a JSON value.");
  } else if (Array.isArray(value)) {
    report("unsupported_value_form", path, "Nested lists are not checked yet.");
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
      "Empty lists are not supported in this value position.",
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

function checkSingleReference(
  value: unknown,
  path: FieldPath,
  report: Report,
  check: typeof checkReference,
  schedule: (work: () => void) => void,
): void {
  checkSingleValue(
    value,
    path,
    (reason, entryPath, message) =>
      schedule(() => report(reason, entryPath, message)),
    (entry, entryPath) => schedule(() => check(entry, entryPath, report)),
  );
}

interface ContextTerm {
  readonly iri: string;
  readonly type?: string | undefined;
  readonly container?: string | undefined;
  readonly prefix: boolean;
}

interface DocumentContext {
  readonly terms: ReadonlyMap<string, ContextTerm>;
}

function sameContextTerm(
  actual: ContextTerm | undefined,
  expected: ContextTerm,
): boolean {
  return (
    actual != null &&
    actual.iri === expected.iri &&
    actual.type === expected.type &&
    actual.container === expected.container &&
    actual.prefix === expected.prefix
  );
}

function isSupportedContextUri(value: string): boolean {
  // URL parsing alone accepts characters that JSON-LD IRI mappings forbid.
  return (
    /^[a-z][a-z\d+.-]*:/iu.test(value) &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0)!;
      return (
        point <= 0x20 ||
        (point >= 0x7f && point <= 0x9f) ||
        '<>"{}|\\^`'.includes(character)
      );
    }) &&
    URL.canParse(value)
  );
}

// Resolve only explicit terms, defined prefixes, keywords, and absolute IRIs.
// This profile deliberately does not implement general JSON-LD expansion.
function resolveTerm(
  value: string,
  terms: ReadonlyMap<string, ContextTerm>,
  pending?: ReadonlySet<string>,
): string | undefined {
  if (value === "@id" || value === "@type") return value;
  if (pending?.has(value)) return undefined;
  const term = terms.get(value);
  if (term != null) return term.iri;
  const colon = value.indexOf(":");
  if (colon < 0) return undefined;
  if (pending?.has(value.slice(0, colon))) return undefined;
  const prefix = terms.get(value.slice(0, colon));
  if (prefix?.prefix) {
    const expanded = prefix.iri + value.slice(colon + 1);
    return isSupportedContextUri(expanded) ? expanded : undefined;
  }
  return isSupportedContextUri(value) ? value : undefined;
}

function readContextTerm(
  definition: unknown,
  path: FieldPath,
  terms: ReadonlyMap<string, ContextTerm>,
  report: Report,
  pending: ReadonlySet<string>,
): ContextTerm | undefined {
  let values: Record<string, unknown>;
  if (typeof definition === "string") values = { "@id": definition };
  else if (
    definition !== null &&
    typeof definition === "object" &&
    !Array.isArray(definition)
  ) {
    const record = readDocument(definition, path, report);
    if (record == null) return undefined;
    values = record;
  } else {
    report(
      definition === null ? "unsupported_context_form" : "invalid_context",
      path,
      "Only string and simple term definitions are supported.",
    );
    return undefined;
  }
  if (
    Object.keys(values).some(
      (key) => !["@id", "@type", "@container", "@prefix"].includes(key),
    )
  ) {
    report(
      "unsupported_context_form",
      path,
      "Scoped contexts, reverse properties, and complex term definitions are not supported.",
    );
    return undefined;
  }
  const id = values["@id"];
  if (id === undefined) {
    report(
      "unsupported_context_form",
      path,
      "Inline term definitions require an explicit @id in this profile.",
    );
    return undefined;
  }
  if (typeof id !== "string") {
    report("invalid_context", path, "Expected a string @id mapping.");
    return undefined;
  }
  if (/^[#/.]/u.test(id) || id.startsWith("_:")) {
    report(
      "unsupported_context_form",
      path,
      "Relative and blank-node term mappings are outside the supported profile.",
    );
    return undefined;
  }
  if (id.startsWith("@") && !["@id", "@type"].includes(id)) {
    report(
      "unsupported_context_form",
      path,
      "This keyword alias is outside the supported profile.",
    );
    return undefined;
  }
  return resolveContextTerm(
    id,
    values,
    typeof definition === "string",
    path,
    terms,
    report,
    pending,
  );
}

function resolveContextTerm(
  id: string,
  values: Record<string, unknown>,
  implicitPrefix: boolean,
  path: FieldPath,
  terms: ReadonlyMap<string, ContextTerm>,
  report: Report,
  pending: ReadonlySet<string>,
): ContextTerm | undefined {
  const iri = resolveTerm(id, terms, pending);
  if (iri == null) return undefined;
  if (iri.startsWith("@") && Object.keys(values).some((key) => key !== "@id")) {
    report(
      "unsupported_context_form",
      path,
      "Keyword aliases with additional coercion or container options are not supported.",
    );
    return undefined;
  }
  const type = values["@type"];
  if (typeof type === "string" && type.startsWith("@") && type !== "@id") {
    report(
      "unsupported_context_form",
      path,
      "This type coercion is outside the supported profile.",
    );
    return undefined;
  }
  const expandedType =
    typeof type === "string" ? resolveTerm(type, terms, pending) : undefined;
  if (type !== undefined && expandedType === undefined) return undefined;
  const container = values["@container"];
  if (container === "@language" && type !== undefined) {
    report(
      "unsupported_context_form",
      path,
      "Language containers with type coercion are not supported.",
    );
    return undefined;
  }
  if (
    container !== undefined &&
    container !== "@language" &&
    container !== "@list"
  ) {
    report(
      "unsupported_context_form",
      path,
      "This container form is not supported.",
    );
    return undefined;
  }
  if (
    values["@prefix"] !== undefined &&
    typeof values["@prefix"] !== "boolean"
  ) {
    report("invalid_context", path, "Expected a boolean @prefix flag.");
    return undefined;
  }
  return {
    iri,
    type: expandedType,
    container,
    prefix:
      values["@prefix"] === true || (implicitPrefix && /[#/:]$/u.test(iri)),
  };
}

function applyContextTerms(
  values: Record<string, unknown>,
  path: FieldPath,
  terms: Map<string, ContextTerm>,
  report: Report,
  protectedTerms?: ReadonlyMap<string, ContextTerm>,
): boolean {
  let valid = true;
  const localReport: Report = (...args) => {
    valid = false;
    report(...args);
  };
  const pending = new Set(Object.keys(values));
  for (const name of pending) terms.delete(name);
  while (pending.size > 0) {
    if (!valid) return false;
    let resolved = false;
    for (const name of pending) {
      const fieldPath = [...path, name];
      if (name.length === 0) {
        localReport(
          "invalid_context",
          fieldPath,
          "A context term cannot be empty.",
        );
        continue;
      }
      if (name.includes(":")) {
        localReport(
          "unsupported_context_form",
          fieldPath,
          "IRI-shaped term definitions are outside the supported inline profile.",
        );
        continue;
      }
      if (name.startsWith("@")) {
        if (
          protectedTerms == null &&
          name === "@vocab" &&
          values[name] === "_:"
        ) {
          pending.delete(name);
        } else {
          localReport(
            "unsupported_context_form",
            fieldPath,
            "This context directive is outside the supported profile.",
          );
        }
        continue;
      }
      const term = readContextTerm(
        values[name],
        fieldPath,
        terms,
        localReport,
        pending,
      );
      if (term == null) continue;
      const original = protectedTerms?.get(name);
      if (original != null && !sameContextTerm(term, original)) {
        localReport(
          "unsupported_context_form",
          fieldPath,
          "The standard ActivityStreams context cannot be overridden.",
        );
        continue;
      }
      terms.set(name, term);
      pending.delete(name);
      resolved = true;
    }
    if (!resolved && pending.size > 0 && valid) {
      for (const name of pending) {
        localReport(
          "invalid_context",
          [...path, name],
          "The term has an unresolved or cyclic IRI mapping.",
        );
      }
    }
  }
  return valid;
}

interface ContextTables {
  readonly bundledContexts: ReadonlyMap<
    string,
    ReadonlyMap<string, ContextTerm>
  >;
  readonly standardTerms: ReadonlyMap<string, ContextTerm>;
  readonly standardContext: DocumentContext;
}

let contextTables: ContextTables | undefined;

// Interpret dependency contexts lazily so a profile mismatch cannot break import.
function getContextTables(): ContextTables {
  if (contextTables != null) return contextTables;
  // Bundled availability is not blanket admission to this bounded profile.
  const bundledContexts = new Map<string, ReadonlyMap<string, ContextTerm>>();
  for (const url of [activityStreamsContext, "https://w3id.org/security/v1"]) {
    const document = preloadedContexts[url] as {
      "@context": Record<string, unknown>;
    };
    const terms = new Map<string, ContextTerm>();
    applyContextTerms(
      document["@context"],
      [],
      terms,
      (_reason, _path, message) => {
        throw new Error(message);
      },
    );
    bundledContexts.set(url, terms);
  }
  const standardTerms = bundledContexts.get(activityStreamsContext)!;
  // Publish the cache only after all definitions have been interpreted.
  contextTables = {
    bundledContexts,
    standardTerms,
    standardContext: { terms: standardTerms },
  };
  return contextTables;
}

function applyContextEntry(
  value: unknown,
  path: FieldPath,
  terms: Map<string, ContextTerm>,
  report: Report,
): boolean {
  const { bundledContexts, standardTerms } = getContextTables();
  if (typeof value === "string") {
    const url =
      value === "http://www.w3.org/ns/activitystreams"
        ? activityStreamsContext
        : value;
    const bundled = bundledContexts.get(url);
    if (bundled == null) {
      report(
        "context_unavailable_offline",
        path,
        "This context is outside the offline allowlist.",
      );
      return false;
    }
    for (const [name, term] of bundled) terms.set(name, term);
    return true;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report(
      value === null || Array.isArray(value)
        ? "unsupported_context_form"
        : "invalid_context",
      path,
      "Expected an allowlisted context or a simple inline context.",
    );
    return false;
  }
  const definitions = readDocument(value, path, report);
  return (
    definitions != null &&
    applyContextTerms(definitions, path, terms, report, standardTerms)
  );
}

// Each child gets its parent's understood context; overrides never affect siblings.
function checkContext(
  values: Record<string, unknown>,
  path: FieldPath,
  report: Report,
  inherited?: DocumentContext,
): DocumentContext | undefined {
  const { standardContext, standardTerms } = getContextTables();
  if (!Object.hasOwn(values, "@context")) {
    if (inherited != null) return inherited;
    report(
      "implicit_activitystreams_context",
      [...path, "@context"],
      "Assuming the ActivityStreams context for this document.",
    );
    return standardContext;
  }
  const terms = new Map(inherited?.terms);
  let valid = true;
  const localReport: Report = (...args) => {
    valid = false;
    report(...args);
  };
  const context = values["@context"];
  const contextPath = [...path, "@context"];
  if (Array.isArray(context)) {
    visitList(context, contextPath, localReport, (entry, entryPath) => {
      if (!applyContextEntry(entry, entryPath, terms, localReport)) {
        valid = false;
      }
    });
  } else if (!applyContextEntry(context, contextPath, terms, localReport)) {
    valid = false;
  }
  if (!valid) return undefined;
  // Require the standard vocabulary, rather than inferring AS from arbitrary terms.
  if (
    ![...standardTerms].every(([name, term]) =>
      sameContextTerm(terms.get(name), term),
    )
  ) {
    report(
      "unsupported_context_form",
      contextPath,
      "The context must include the standard ActivityStreams vocabulary.",
    );
    return undefined;
  }
  return { terms };
}

interface SourceProperty {
  readonly source: string;
  readonly name?: string;
  readonly iri?: string;
  readonly compatible: boolean;
}

// Retain one entry per source field. Aliases are never merged or re-serialized.
function resolveProperty(
  source: string,
  context: DocumentContext,
): SourceProperty {
  const { standardTerms } = getContextTables();
  const term = context.terms.get(source);
  const iri = term?.iri ?? resolveTerm(source, context.terms);
  for (const [name, standard] of standardTerms) {
    if (iri !== standard.iri || term?.container !== standard.container) {
      continue;
    }
    return {
      source,
      name,
      iri: standard.iri,
      compatible: term?.type === standard.type,
    };
  }
  if (iri === "@id") {
    return { source, name: "id", iri: "@id", compatible: true };
  }
  if (iri === "@type") {
    return { source, name: "type", iri: "@type", compatible: true };
  }
  return { source, ...(iri == null ? {} : { iri }), compatible: false };
}

function isOpaqueExtension(field: SourceProperty): boolean {
  const { standardTerms } = getContextTables();
  return (
    !field.source.startsWith("@") &&
    !field.iri?.startsWith("@") &&
    !Array.from(standardTerms.values()).some((term) => term.iri === field.iri)
  );
}

function isTypeCombination(value: unknown): boolean {
  if (!Array.isArray(value) || value.length <= 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      descriptor == null ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      return false;
    }
  }
  return true;
}

function checkType(
  value: unknown,
  path: FieldPath,
  report: Report,
  context: DocumentContext,
): VocabularyType | undefined {
  const typeIri =
    typeof value === "string" ? resolveTerm(value, context.terms) : undefined;
  let Type: VocabularyType | undefined;
  if (typeIri != null) {
    Type = getEntityTypeById(typeIri);
    // Link classes are exported separately from Fedify's entity registry.
    if (typeIri === Link.typeId.href) Type = Link;
    else if (typeIri === Mention.typeId.href) Type = Mention;
  }
  if (Type == null || !implementedTypes.has(Type)) {
    const reason = Array.isArray(value)
      ? "unsupported_value_form"
      : value == null || typeof value === "string"
        ? "unsupported_type"
        : "invalid_value_shape";
    report(
      reason,
      path,
      isTypeCombination(value)
        ? "Type combinations are not supported. Provide a single supported type."
        : Array.isArray(value)
          ? "Type arrays are not supported. Provide a single type string."
          : "This type is not supported by the checker yet.",
    );
    return undefined;
  }

  return Type;
}

function isTypeOrSubtype(Type: VocabularyType, Base: VocabularyType): boolean {
  return Type === Base || Type.prototype instanceof Base;
}

function checkEmbeddedFedifyRange(
  Type: VocabularyType,
  expected: readonly VocabularyType[] | undefined,
  path: FieldPath,
  report: Report,
): void {
  if (expected?.every((Expected) => !isTypeOrSubtype(Type, Expected))) {
    report(
      "unsupported_value_form",
      path,
      `Fedify cannot preserve this embedded type for this property. Use ${expected.map((Expected) => Expected.name).join(", ")} or an IRI reference.`,
    );
  }
}

function getEmbeddedFedifyRange(
  property: string,
  collectionRange: readonly VocabularyType[] | undefined,
): readonly VocabularyType[] | undefined {
  if (property === "actor" || property === "attributedTo") return actorTypes;
  return collectionRange?.filter((Expected) => Expected !== Link);
}

function checkDocumentType(
  values: Record<string, unknown>,
  fields: readonly SourceProperty[],
  path: FieldPath,
  context: DocumentContext,
  report: Report,
): VocabularyType | undefined {
  const types = fields.filter(({ name }) => name === "type");
  if (types.length > 1) {
    for (const field of types) {
      report(
        "unsupported_value_form",
        [...path, field.source],
        "Multiple type declarations are not supported. Provide a single type field.",
      );
    }
    return undefined;
  }
  const source = types[0]?.source ?? "type";
  return checkType(values[source], [...path, source], report, context);
}

// Collection navigation and actor collection links each identify one resource.
function getCollectionRange(
  Type: VocabularyType,
  property: string,
): readonly VocabularyType[] | undefined {
  if (isTypeOrSubtype(Type, Collection)) {
    if (["current", "first", "last"].includes(property)) {
      return [CollectionPage, Link];
    }
  }
  if (isTypeOrSubtype(Type, CollectionPage)) {
    if (property === "partOf") return [Collection, Link];
    if (["next", "prev"].includes(property)) return [CollectionPage, Link];
  }
  const actor = actorTypes.some((Actor) => isTypeOrSubtype(Type, Actor));
  if (actor) {
    if (["inbox", "outbox"].includes(property)) {
      return [OrderedCollection, OrderedCollectionPage];
    }
    if (["following", "followers", "liked"].includes(property)) {
      return [Collection];
    }
  }
  return undefined;
}

function isFunctionalProperty(Type: VocabularyType, property: string): boolean {
  if (["id", "mediaType"].includes(property)) return true;
  if (getCollectionRange(Type, property) != null) return true;
  if (isTypeOrSubtype(Type, Link)) {
    return ["href", "height", "width", "hreflang"].includes(property);
  }
  if (["published", "updated", "startTime", "endTime"].includes(property)) {
    return true;
  }
  if (isTypeOrSubtype(Type, Collection) && property === "totalItems") {
    return true;
  }
  return (
    isTypeOrSubtype(Type, OrderedCollectionPage) && property === "startIndex"
  );
}

// Count original data slots without reading accessors; the value checks report
// sparse/accessor entries separately. Null entries do not contribute a value.
function countValues(value: unknown): number {
  if (!Array.isArray(value)) return value === null ? 0 : 1;
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      descriptor != null &&
      "value" in descriptor &&
      descriptor.value !== null
    ) {
      count += 1;
    }
  }
  return count;
}

function findMultipleAliases(
  Type: VocabularyType,
  fields: readonly SourceProperty[],
  values: Record<string, unknown>,
): ReadonlySet<string> {
  const groups = new Map<string, string[]>();
  for (const field of fields) {
    if (
      field.name == null ||
      field.iri == null ||
      !isFunctionalProperty(Type, field.name)
    ) {
      continue;
    }
    if (countValues(values[field.source]) === 0) continue;
    const group = groups.get(field.iri) ?? [];
    group.push(field.source);
    groups.set(field.iri, group);
  }
  const multiple = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const source of group) {
      // The existing functional-array check reports its own multiplicity.
      if (countValues(values[source]) <= 1) multiple.add(source);
    }
  }
  return multiple;
}

function checkNonNegativeInteger(
  value: unknown,
  path: FieldPath,
  report: Report,
): void {
  if (value === null) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    report("invalid_value_shape", path, "Expected a non-negative integer.");
  }
}

// Functional properties count non-null values but retain source array indexes.
function checkSingleValue(
  value: unknown,
  path: FieldPath,
  report: Report,
  check: typeof checkReference,
): void {
  if (!Array.isArray(value)) {
    check(value, path, report);
    return;
  }
  if (value.length === 0) {
    report(
      "unsupported_value_form",
      path,
      "Empty lists are not supported in this value position.",
    );
    return;
  }
  const entries: { value: unknown; path: FieldPath }[] = [];
  visitList(value, path, report, (entry, entryPath) => {
    if (entry !== null) entries.push({ value: entry, path: entryPath });
  });
  if (entries.length > 1) {
    report(
      "invalid_multiplicity",
      path,
      "Expected at most one non-null value.",
    );
  }
  for (const entry of entries) {
    checkReferenceEntry(entry.value, entry.path, report, check);
  }
}

function checkLanguageTag(
  value: unknown,
  path: FieldPath,
  report: Report,
): void {
  if (
    typeof value !== "string" ||
    !/^[a-z]{1,8}(?:-[a-z\d]{1,8})*$/iu.test(value)
  ) {
    report("invalid_value_shape", path, "Expected a language tag.");
    return;
  }
  try {
    void new Intl.Locale(value);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    report(
      "unsupported_value_form",
      path,
      "This language tag is outside the current locale parser's support.",
    );
  }
}

function checkText(
  value: unknown,
  path: FieldPath,
  report: Report,
  plain: boolean,
): void {
  if (value === null) return;
  if (typeof value === "string") {
    if (plain && /<(?:[a-z][^>]*>|\/[a-z][^>]*>|!--)/iu.test(value)) {
      report(
        "invalid_value_shape",
        path,
        "Names must be plain text without HTML markup.",
      );
    }
    return;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    report("invalid_value_shape", path, "Expected text.");
    return;
  }
  const values = readDocument(value, path, report);
  if (values == null) return;
  if (!Object.hasOwn(values, "@value")) {
    report(
      "unsupported_value_form",
      path,
      "Use a language-map property or an explicit @value object for localized text.",
    );
    return;
  }
  for (const key of Object.keys(values).sort()) {
    const fieldPath = [...path, key];
    if (key === "@value") {
      if (typeof values[key] === "string") {
        checkText(values[key], fieldPath, report, plain);
      } else {
        report("invalid_value_shape", fieldPath, "Expected a text value.");
      }
    } else if (key === "@language") {
      checkLanguageTag(values[key], fieldPath, report);
    } else {
      report(
        "unsupported_value_form",
        fieldPath,
        "This text-value attribute is not supported yet.",
      );
    }
  }
}

function checkLanguageMap(
  value: unknown,
  path: FieldPath,
  report: Report,
  plain: boolean,
): void {
  if (value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    report("invalid_value_shape", path, "Expected a language map.");
    return;
  }
  const values = readDocument(value, path, report);
  if (values == null) return;
  for (const language of Object.keys(values).sort()) {
    const fieldPath = [...path, language];
    checkLanguageTag(language, fieldPath, report);
    if (values[language] === null) continue;
    if (typeof values[language] === "string") {
      checkText(values[language], fieldPath, report, plain);
    } else {
      report(
        "invalid_value_shape",
        fieldPath,
        "Expected a language-map string.",
      );
    }
  }
}

function checkDateTime(value: unknown, path: FieldPath, report: Report): void {
  if (value === null) return;
  if (typeof value !== "string") {
    report("invalid_value_shape", path, "Expected a date-time string.");
    return;
  }
  // AS2 permits omitted seconds, but requires an offset and uppercase T/Z.
  const match =
    /^(?<minute>\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?<second>:\d{2})?(?<fraction>\.\d+)?(?<offset>Z|[+-]\d{2}:\d{2})$/u.exec(
      value,
    );
  if (match == null) {
    report(
      "invalid_datetime",
      path,
      "Expected an ActivityStreams date-time with a timezone.",
    );
    return;
  }
  const { minute, second, fraction, offset } = match.groups!;
  // Check calendar components separately from representation support.
  try {
    void Temporal.Instant.from(`${minute}${second ?? ":00"}${offset}`);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    report(
      "invalid_datetime",
      path,
      "Expected a valid calendar date, time, and offset.",
    );
    return;
  }
  if (second === ":60") {
    report(
      "unsupported_value_form",
      path,
      "Leap-second timestamps are not checked by the current date-time parser.",
    );
    return;
  }
  // Native Temporal can be more permissive than Fedify's parser. Require
  // explicit seconds and nanosecond precision before parsing the original.
  if (second == null) {
    report(
      "unsupported_value_form",
      path,
      fraction != null
        ? "ActivityStreams permits fractions without seconds, but Fedify requires explicit seconds before a fractional component."
        : "ActivityStreams permits omitted seconds, but Fedify requires explicit seconds, such as 12:34:00Z.",
    );
    return;
  }
  if (fraction != null && fraction.length > 10) {
    report(
      "unsupported_value_form",
      path,
      "Fractional seconds exceeding nine digits cannot be preserved through Fedify parsing; provide at most nine fractional digits.",
    );
    return;
  }
  try {
    void Temporal.Instant.from(value);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    report(
      "unsupported_value_form",
      path,
      "This date-time matches the ActivityStreams format, but cannot be parsed as an instant without rewriting; provide a timestamp such as 2024-01-01T12:34:00Z.",
    );
  }
}

// Share coverage classification with empty-array omission admission.
function getCommonPropertyKind(
  Type: VocabularyType,
  property: string,
): "text" | "languageMap" | "datetime" | "id" | "mediaType" | undefined {
  const object = isTypeOrSubtype(Type, APObject);
  const actor = actorTypes.some((Actor) => isTypeOrSubtype(Type, Actor));
  const textProperties = object ? ["name", "summary", "content"] : ["name"];
  if (actor) textProperties.push("preferredUsername");
  if (textProperties.includes(property)) return "text";
  if (
    textProperties.some(
      (name) => property === `${name}Map` && name !== "preferredUsername",
    )
  ) {
    return "languageMap";
  }
  if (
    object &&
    ["published", "updated", "startTime", "endTime"].includes(property)
  ) {
    return "datetime";
  }
  if (property === "id" || property === "mediaType") return property;
  return undefined;
}

// Scalar/common properties share checks; embedded references use the work stack.
function checkCommonProperty(
  kind: ReturnType<typeof getCommonPropertyKind>,
  property: string,
  value: unknown,
  path: FieldPath,
  report: Report,
): boolean {
  if (kind === "text") {
    checkReferenceValues(value, path, report, (entry, entryPath) =>
      checkText(entry, entryPath, report, property === "name"),
    );
  } else if (kind === "languageMap") {
    checkLanguageMap(value, path, report, property === "nameMap");
  } else if (kind === "datetime") {
    checkSingleValue(value, path, report, checkDateTime);
  } else if (kind === "id") {
    if (typeof value !== "string") {
      report("invalid_value_shape", path, "Expected an IRI identifier string.");
    } else {
      checkReference(value, path, report);
    }
  } else if (kind === "mediaType") {
    checkSingleValue(value, path, report, (entry, entryPath) =>
      checkLinkProperty(property, entry, entryPath, report),
    );
  } else {
    // Null is absent even when this vocabulary property has no value rules yet.
    return value === null;
  }
  return true;
}

function proposePropertyOmission(
  value: unknown,
  path: FieldPath,
  report: Report,
  changes: NormalizationChange[],
  identifier: boolean,
): boolean {
  const emptyArray = Array.isArray(value) && value.length === 0;
  if (!emptyArray && !identifier) return false;
  if (value !== null && !Array.isArray(value)) return false;
  let safe = true;
  let absent = true;
  if (Array.isArray(value)) {
    visitList(
      value,
      path,
      (...args) => {
        safe = false;
        report(...args);
      },
      (entry) => {
        if (entry !== null) absent = false;
      },
    );
  }
  if (!safe) return true;
  if (!absent) return false;
  report(
    emptyArray ? "empty_property_list" : "absent_identifier",
    path,
    emptyArray
      ? "ActivityStreams represents empty property arrays by omission or null; the preview omits this property."
      : "This identifier is absent; the preview omits it so Fedify receives no non-string identifier.",
  );
  changes.push({
    operation: "remove",
    reason: emptyArray ? "omit_empty_property_list" : "omit_absent_identifier",
    path,
    before: value as JsonValue,
    message: emptyArray
      ? "Omit an empty property array from the wire representation."
      : "Omit an absent identifier from the wire representation.",
  });
  return true;
}

function checkLinkRelation(
  value: unknown,
  path: FieldPath,
  report: Report,
): void {
  if (value === null) return;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) <= 0x20 ||
        character.charCodeAt(0) === 0x7f ||
        character === ",",
    )
  ) {
    report(
      "invalid_value_shape",
      path,
      "Expected a relation token or absolute IRI without whitespace or commas.",
    );
  } else if (/^[a-z][a-z\d+.-]*:/iu.test(value)) {
    checkReference(value, path, report);
  } else if (!/^[a-z][a-z\d.-]*$/iu.test(value)) {
    report(
      "invalid_value_shape",
      path,
      "Expected a relation token or absolute IRI.",
    );
  }
}

// Link metadata uses lexical checks without rewriting the original values.
function checkLinkProperty(
  property: string,
  value: unknown,
  path: FieldPath,
  report: Report,
): void {
  if (property === "rel") {
    checkReferenceValues(value, path, report, checkLinkRelation);
    return;
  }
  if (value === null) return;
  if (typeof value !== "string") {
    report("invalid_value_shape", path, "Expected a string.");
    return;
  }
  if (property === "href") {
    checkReference(value, path, report);
  } else if (property === "mediaType") {
    try {
      void new MIMEType(value);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      report("invalid_value_shape", path, "Expected a MIME media type.");
    }
  } else {
    checkLanguageTag(value, path, report);
  }
}

// Check explicit keyword shapes, without expanding contexts or keyword aliases.
// Return whether @value contains literal JSON rather than nested JSON-LD.
function checkExtensionKeywords(
  values: Record<string, unknown>,
  path: FieldPath,
  report: Report,
): boolean {
  if (Object.hasOwn(values, "@id") && typeof values["@id"] !== "string") {
    report(
      "invalid_value_shape",
      [...path, "@id"],
      "Expected a string JSON-LD identifier.",
    );
  }
  let jsonLiteral = values["@type"] === "@json";
  if (Object.hasOwn(values, "@type")) {
    const type = values["@type"];
    if (Array.isArray(type)) {
      visitList(type, [...path, "@type"], report, (entry, entryPath) => {
        if (typeof entry !== "string") {
          report(
            "invalid_value_shape",
            entryPath,
            "Expected a JSON-LD type string.",
          );
        }
        if (type.length === 1 && entry === "@json") jsonLiteral = true;
      });
    } else if (typeof type !== "string") {
      report(
        "invalid_value_shape",
        [...path, "@type"],
        "Expected a JSON-LD type string or array of strings.",
      );
    }
  }
  if (Object.hasOwn(values, "@value") && values["@language"] != null) {
    if (typeof values["@language"] !== "string") {
      report(
        "invalid_value_shape",
        [...path, "@language"],
        "Expected a string language tag or null.",
      );
    }
    if (values["@value"] !== null && typeof values["@value"] !== "string") {
      report(
        "invalid_value_shape",
        [...path, "@value"],
        "A JSON-LD language-tagged value must have a string @value or null absence.",
      );
    }
  }
  return jsonLiteral;
}

function checkDocumentValue(
  rootDocument: unknown,
  rootPath: FieldPath,
  reporter: ReturnType<typeof createReporter>,
  changes: NormalizationChange[],
  onDocument?: (
    values: Record<string, unknown>,
    path: FieldPath,
    context: DocumentContext,
  ) => void,
  onUnavailableDocument: (path: FieldPath) => void = () => undefined,
): void {
  const { report, isFull } = reporter;
  const pending: (() => void)[] = [];
  const ancestors = new WeakSet<object>();

  // Check JSON safety and selected explicit keyword shapes. This is not full
  // JSON-LD validation; extension semantics and nested contexts remain unchecked.
  function checkExtension(
    value: unknown,
    path: FieldPath,
    keywords = true,
  ): void {
    if (!isJsonValueShape(value)) {
      report("non_json_value", path, "Expected a JSON value.");
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (ancestors.has(value)) {
      report("non_json_value", path, "JSON documents cannot contain cycles.");
      return;
    }
    ancestors.add(value);
    pending.push(() => ancestors.delete(value));
    const children: (() => void)[] = [];
    if (Array.isArray(value)) {
      visitList(value, path, report, (entry, entryPath) => {
        children.push(() => checkExtension(entry, entryPath, keywords));
      });
    } else {
      const values = readDocument(value, path, report);
      if (values != null) {
        const jsonLiteral =
          keywords && checkExtensionKeywords(values, path, report);
        for (const key of Object.keys(values)) {
          const childKeywords = keywords && !(jsonLiteral && key === "@value");
          children.push(() =>
            checkExtension(values[key], [...path, key], childKeywords),
          );
        }
      }
    }
    for (const child of children.reverse()) pending.push(child);
  }

  function checkDocument(
    document: unknown,
    path: FieldPath,
    inherited?: DocumentContext,
    expectedTypes?: readonly VocabularyType[],
    fedifyTypes?: readonly VocabularyType[],
  ): void {
    if (
      document !== null &&
      typeof document === "object" &&
      ancestors.has(document)
    ) {
      report("non_json_value", path, "JSON documents cannot contain cycles.");
      onUnavailableDocument(path);
      return;
    }
    const values = readDocument(document, path, report);
    if (values == null) {
      onUnavailableDocument(path);
      return;
    }
    const sourceDocument = document as object;
    const context = checkContext(values, path, report, inherited);
    if (context == null) {
      onUnavailableDocument(path);
      return;
    }
    const fields = Object.keys(values)
      .filter((source) => source !== "@context")
      .sort()
      .map((source) => resolveProperty(source, context));
    const Type = checkDocumentType(values, fields, path, context, report);
    if (Type == null) {
      onUnavailableDocument(path);
      return;
    }
    if (expectedTypes?.every((Expected) => !isTypeOrSubtype(Type, Expected))) {
      report(
        "invalid_value_shape",
        path,
        "The embedded type is outside this property's collection range.",
      );
      onUnavailableDocument(path);
      return;
    }
    checkEmbeddedFedifyRange(Type, fedifyTypes, path, report);
    onDocument?.(values, path, context);
    const isObject = isTypeOrSubtype(Type, APObject);
    const isLink = isTypeOrSubtype(Type, Link);
    const isActivity = isTypeOrSubtype(Type, Activity);
    const isIntransitive = isTypeOrSubtype(Type, IntransitiveActivity);
    const isCollection = isTypeOrSubtype(Type, Collection);
    const isOrderedPage = isTypeOrSubtype(Type, OrderedCollectionPage);
    const linkProperties = isLink
      ? ["href", "mediaType", "hreflang", "rel"]
      : [];
    const integerProperties = isLink
      ? ["height", "width"]
      : isOrderedPage
        ? ["totalItems", "startIndex"]
        : isCollection
          ? ["totalItems"]
          : [];
    const referenceProperties = ["preview"];
    if (isObject) {
      referenceProperties.push(
        "attributedTo",
        "location",
        ...addressingProperties,
      );
    }
    if (isActivity) {
      referenceProperties.push(
        "actor",
        "object",
        "target",
        "origin",
        "result",
        "instrument",
      );
    }
    if (isCollection) referenceProperties.push("items", "orderedItems");
    const omittableProperties = new Set([
      ...integerProperties,
      ...linkProperties,
      ...referenceProperties,
    ]);
    const multipleAliases = findMultipleAliases(Type, fields, values);

    ancestors.add(sourceDocument);
    pending.push(() => {
      ancestors.delete(sourceDocument);
    });
    // LIFO work preserves the same depth-first, sorted-property order.
    for (const field of fields.reverse()) {
      const { source, name: key } = field;
      if (key === "type") continue;
      const intransitiveObject = isIntransitive && key === "object";
      pending.push(() => {
        const value = values[source];
        const fieldPath = [...path, source];
        if (key == null) {
          if (isOpaqueExtension(field)) {
            report(
              "extension_property_unchecked",
              fieldPath,
              "This custom property's data is preserved; its semantics were not checked.",
            );
            checkExtension(value, fieldPath);
            return;
          }
          report(
            "unsupported_property",
            fieldPath,
            "This property is outside the checker's Fedify vocabulary coverage.",
          );
          return;
        }
        if (!field.compatible) {
          report(
            "unsupported_value_form",
            fieldPath,
            "This spelling's type coercion differs from the supported vocabulary term.",
          );
          return;
        }
        if (isLink && objectOnlyProperties.has(key)) {
          report(
            "property_not_applicable",
            fieldPath,
            "This property applies to Object documents, not Link documents.",
          );
          return;
        }
        if (multipleAliases.has(source)) {
          report(
            "invalid_multiplicity",
            fieldPath,
            "Multiple aliases supply values for one functional property.",
          );
        }
        const collectionRange = getCollectionRange(Type, key);
        const commonKind = getCommonPropertyKind(Type, key);
        const supported =
          omittableProperties.has(key) ||
          collectionRange != null ||
          commonKind != null;
        // Preview omission of empty supported arrays and absent identifiers.
        if (
          supported &&
          proposePropertyOmission(
            value,
            fieldPath,
            report,
            changes,
            commonKind === "id",
          )
        ) {
          return;
        }
        if (integerProperties.includes(key)) {
          checkSingleValue(value, fieldPath, report, checkNonNegativeInteger);
        } else if (linkProperties.includes(key)) {
          if (key === "rel") {
            checkLinkProperty(key, value, fieldPath, report);
          } else {
            checkSingleValue(value, fieldPath, report, (entry, entryPath) =>
              checkLinkProperty(key, entry, entryPath, report),
            );
          }
        } else if (
          checkCommonProperty(commonKind, key, value, fieldPath, report)
        ) {
          // Common properties and null absence were checked above.
        } else if (intransitiveObject) {
          checkReferenceValues(value, fieldPath, report, (entry, entryPath) => {
            if (entry !== null) {
              report(
                "property_not_applicable",
                entryPath,
                "The object property does not apply to intransitive activities.",
              );
            }
          });
        } else if (
          referenceProperties.includes(key) ||
          collectionRange != null
        ) {
          const checks: (() => void)[] = [];
          const checkValues =
            collectionRange == null
              ? checkReferenceValues
              : checkSingleReference;
          checkValues(
            value,
            fieldPath,
            report,
            (entry, entryPath) => {
              if (
                entry !== null &&
                typeof entry === "object" &&
                !Array.isArray(entry)
              ) {
                // AS ranges can be wider than Fedify's typed decoders. Keep
                // vocabulary errors distinct from unsupported embedded forms.
                checkDocument(
                  entry,
                  entryPath,
                  context,
                  collectionRange,
                  getEmbeddedFedifyRange(key, collectionRange),
                );
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

  checkDocument(rootDocument, rootPath);
  while (pending.length > 0 && !isFull()) {
    pending.pop()!();
  }
}

// Clone checked JSON iteratively so a deeply nested preview cannot overflow
// the JavaScript call stack or share mutable containers with the input.
function createPreview(
  document: { [key: string]: JsonValue },
  changes: readonly NormalizationChange[],
): { [key: string]: JsonValue } {
  const root: { [key: string]: JsonValue } = {};
  const pending = [
    {
      source: document as object,
      target: root as { [key: string]: JsonValue },
    },
  ];
  while (pending.length > 0) {
    const { source, target } = pending.pop()!;
    for (const [key, value] of Object.entries(source)) {
      let copy = value as JsonValue;
      if (value !== null && typeof value === "object") {
        // Each JSON occurrence has its own path and proposed field values.
        copy = Array.isArray(value) ? [] : {};
        pending.push({
          source: value,
          target: copy as { [key: string]: JsonValue },
        });
      }
      Object.defineProperty(target, key, {
        value: copy,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
  }
  for (const change of changes) {
    let parent = root;
    for (const key of change.path.slice(0, -1)) {
      parent = parent[key] as { [key: string]: JsonValue };
    }
    const key = change.path.at(-1)!;
    if (change.operation === "remove") delete parent[key];
    else {
      Object.defineProperty(parent, key, {
        value: change.after,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
  }
  return root;
}

/**
 * Checks the implemented Activity Vocabulary types, including nested
 * activity objects, without network access or writes. Embedded objects inherit
 * the parent's context. Collections add member, count, and navigation checks.
 * Question uses shared intransitive rules; poll-specific
 * fields remain unsupported pending #155.
 *
 * Supports allowlisted bundled contexts and simple inline aliases/prefixes,
 * single types, id, string content,
 * attribution/location and activity actor, object, target, origin, result,
 * and instrument values. These can be IRI references or supported
 * embedded types, singly or in flat lists. Empty supported property arrays
 * receive omission previews. Intransitive activities
 * reject a non-null object property. Other forms produce
 * support diagnostics and `complete: false`. This is not a permission check,
 * a Fedify parsability check, or full ActivityStreams validation.
 * The input must be plain JSON data, not a Proxy.
 * Context interpretation is bounded and synchronous. Unknown
 * custom properties are preserved as opaque JSON with warnings. Complex
 * contexts remain unsupported; input is never expanded.
 * Null list entries mean absence. Functional properties accept at most one
 * non-null value, preserving array-index paths. Common text/language maps,
 * timestamps, actor preferredUsername, and addressing are checked.
 * @returns Findings at original-input paths, with an explicit omission preview
 * for empty supported property arrays and absent identifiers only when validation
 * completes without errors.
 */
export function validateDocument(document: unknown): DocumentValidationResult {
  const reporter = createReporter();
  const changes: NormalizationChange[] = [];
  checkDocumentValue(document, [], reporter, changes);
  const result = reporter.result();
  if (
    !result.complete ||
    result.diagnostics.some(({ severity }) => severity === "error") ||
    changes.length === 0
  ) {
    return result;
  }
  const preview = createPreview(
    document as { [key: string]: JsonValue },
    changes,
  );
  const checked = validateDocument(preview);
  reportPreviewDiagnostics(result, checked, reporter.report);
  const previewResult = reporter.result();
  if (
    !checked.complete ||
    !previewResult.complete ||
    previewResult.diagnostics.some(({ severity }) => severity === "error")
  ) {
    return {
      ...previewResult,
      complete: checked.complete && previewResult.complete,
    };
  }
  return { ...previewResult, changes, normalizedDocument: preview };
}

// Preview checks retain source diagnostics without repeating unchanged findings.
function reportPreviewDiagnostics(
  original: DocumentValidationResult,
  checked: DocumentValidationResult,
  report: Report,
): void {
  for (const diagnostic of checked.diagnostics) {
    if (
      !original.diagnostics.some(
        (existing) =>
          existing.reason === diagnostic.reason &&
          JSON.stringify(existing.path) === JSON.stringify(diagnostic.path),
      )
    ) {
      report(diagnostic.reason, diagnostic.path, diagnostic.message);
    }
  }
}

interface PreparationTarget {
  readonly values: Record<string, unknown>;
  readonly context: DocumentContext;
}

// #152 supplies these options after its own permission checks and allocation.
// TypeErrors identify caller mistakes; document problems use diagnostics.
// Validating option shapes does not authenticate their source.
function checkPreparationOptions(options: DocumentPreparationOptions): void {
  const validPath = (path: FieldPath) =>
    Array.isArray(path) &&
    path.every(
      (part) =>
        typeof part === "string" ||
        (typeof part === "number" && Number.isSafeInteger(part) && part >= 0),
    );
  if (
    options == null ||
    !Array.isArray(options.authority) ||
    options.authority.length === 0 ||
    options.authority.some(
      (outcome) =>
        outcome == null ||
        typeof outcome.allowed !== "boolean" ||
        !validPath(outcome.path),
    ) ||
    !Array.isArray(options.serverOwnedFields) ||
    options.serverOwnedFields.some(
      (field) =>
        field == null ||
        !validPath(field.path) ||
        typeof field.path.at(-1) !== "string" ||
        typeof field.value !== "string",
    )
  ) {
    throw new TypeError(
      "Expected explicit trusted authority outcomes and server-owned fields.",
    );
  }
}

// Inspect source paths without executing accessors, even on invalid documents.
function isMissingPreparationParent(
  document: unknown,
  path: FieldPath,
): boolean {
  let value = document;
  for (const [index, part] of path.entries()) {
    if (value === null || typeof value !== "object") return index > 0;
    const descriptor = Object.getOwnPropertyDescriptor(value, part);
    if (descriptor == null) return true;
    if (!("value" in descriptor)) return false;
    ({ value } = descriptor);
  }
  return false;
}

function checkServerOwnedFields(
  document: unknown,
  fields: readonly ServerOwnedField[],
  targets: ReadonlyMap<string, PreparationTarget>,
  unavailable: readonly FieldPath[],
  truncated: boolean,
): { field: ServerOwnedField; target: PreparationTarget; property: string }[] {
  const seen = new Set<string>();
  const checked = [];
  for (const field of fields) {
    const parent = field.path.slice(0, -1);
    if (isMissingPreparationParent(document, parent)) {
      throw new TypeError("Server-owned field parent path does not exist.");
    }
    const target = targets.get(JSON.stringify(parent));
    if (target == null) {
      // A failed type/context check cannot establish semantic target identity.
      const blocked = unavailable.some((path) =>
        path.every((part, index) => parent[index] === part),
      );
      if (blocked || truncated) {
        const source = field.path.at(-1) as string;
        const { standardContext } = getContextTables();
        if (resolveProperty(source, standardContext).name != null) {
          checkServerOwnedField(field, standardContext, seen);
        }
        continue;
      }
      throw new TypeError(
        "Server-owned field parents must be existing supported documents, not references or opaque data.",
      );
    }
    const property = checkServerOwnedField(field, target.context, seen);
    checked.push({ field, target, property });
  }
  return checked;
}

// Validate caller configuration before document errors can stop preparation.
function checkServerOwnedField(
  field: ServerOwnedField,
  context: DocumentContext,
  seen: Set<string>,
): string {
  const parentPath = field.path.slice(0, -1);
  const source = field.path.at(-1) as string;
  const resolved = resolveProperty(source, context);
  const property = resolved.name;
  if (
    !resolved.compatible ||
    property == null ||
    !["id", "actor", "attributedTo", "published", "updated"].includes(property)
  ) {
    throw new TypeError(
      "Server-owned fields must identify a supported identity or timestamp property.",
    );
  }
  const identity = JSON.stringify([...parentPath, property]);
  if (seen.has(identity)) {
    throw new TypeError(
      "Specify each server-owned semantic field only once, including aliases.",
    );
  }
  seen.add(identity);
  const invalidServerValue: Report = () => {
    throw new TypeError(`Invalid server-owned value for ${property}.`);
  };
  if (property === "published" || property === "updated") {
    checkDateTime(field.value, field.path, invalidServerValue);
  } else {
    checkReference(field.value, field.path, invalidServerValue);
  }
  return property;
}

// Compare a checked server-owned value without rewriting a submitted claim.
function proposeServerField(
  field: ServerOwnedField,
  target: PreparationTarget,
  property: string,
  report: Report,
  changes: NormalizationChange[],
): void {
  const parentPath = field.path.slice(0, -1);
  const source = field.path.at(-1) as string;
  const aliases = Object.keys(target.values).filter(
    (key) => resolveProperty(key, target.context).name === property,
  );
  const supplied = aliases.flatMap((key) => {
    const value = target.values[key];
    const path = [...parentPath, key];
    if (Array.isArray(value)) {
      return value.flatMap((entry, index) =>
        entry === null ? [] : [{ entry, path: [...path, index] }],
      );
    }
    return value === null ? [] : [{ entry: value, path }];
  });
  if (supplied.length > 0) {
    if (supplied.length !== 1 || supplied[0]!.entry !== field.value) {
      for (const suppliedValue of supplied) {
        report(
          "server_owned_field_conflict",
          suppliedValue.path,
          "This field must match the server-owned value for this creation operation.",
        );
      }
    }
    return;
  }
  // Prefer the requested source spelling even when another null alias exists.
  const key = Object.hasOwn(target.values, source)
    ? source
    : (aliases[0] ?? source);
  const path = [...parentPath, key];
  const common = {
    reason: "assign_server_owned_field",
    path,
    after: field.value,
    message: `Use the server-proposed ${property} for this creation operation.`,
  };
  changes.push(
    Object.hasOwn(target.values, key)
      ? {
          ...common,
          operation: "replace",
          before: target.values[key] as JsonValue,
        }
      : { ...common, operation: "add" },
  );
}

/**
 * Prepares a creation preview against trusted server values and permission
 * outcomes. Does not determine authorization, allocate values, or persist.
 *
 * Integration boundary: https://github.com/fedify-dev/drfed/issues/152
 * The write operation constructs options from trusted server state, not client
 * JSON. It must check every local write, including nested creations, and recheck
 * permissions at commit. This preview is not an authorization token. The caller
 * also owns keeping committed IDs/timestamps consistent with the shown preview.
 * Merely referencing or embedding an actor/resource does not request a write.
 *
 * Paths identify original source locations; owned-field aliases are resolved
 * within the supported context profile. Matching singleton values are retained;
 * absent/null values receive explicit additions/replacements. Conflicts block
 * the preview. Throws TypeError for invalid trusted options/target paths.
 * @returns Original-input diagnostics and any explicit creation preview changes.
 */
export function prepareDocument(
  document: unknown,
  options: DocumentPreparationOptions,
): DocumentValidationResult {
  checkPreparationOptions(options);
  const reporter = createReporter();
  const changes: NormalizationChange[] = [];
  const requested = new Set(
    options.serverOwnedFields.map(({ path }) =>
      JSON.stringify(path.slice(0, -1)),
    ),
  );
  const targets = new Map<string, PreparationTarget>();
  const unavailable: FieldPath[] = [];
  // Use only documents reached by vocabulary traversal: arbitrary extension
  // objects and unresolved IRI references must not become local write targets.
  checkDocumentValue(
    document,
    [],
    reporter,
    changes,
    (values, path, context) => {
      const key = JSON.stringify(path);
      if (requested.has(key)) targets.set(key, { values, context });
    },
    (path) => unavailable.push(path),
  );
  const structural = reporter.result();
  const checkedFields = checkServerOwnedFields(
    document,
    options.serverOwnedFields,
    targets,
    unavailable,
    structural.diagnostics.some(
      ({ reason }) => reason === "diagnostic_limit_reached",
    ),
  );
  for (const outcome of options.authority) {
    if (!outcome.allowed) {
      reporter.report(
        "unauthorized_local_identity",
        [...outcome.path],
        "The server denied use of this local identity for the requested operation.",
      );
    }
  }
  let result = reporter.result();
  if (
    !result.complete ||
    result.diagnostics.some(({ severity }) => severity === "error")
  ) {
    return result;
  }
  for (const { field, target, property } of checkedFields) {
    proposeServerField(field, target, property, reporter.report, changes);
  }
  result = reporter.result();
  if (
    !result.complete ||
    result.diagnostics.some(({ severity }) => severity === "error") ||
    changes.length === 0
  ) {
    return result;
  }
  // A server-owned replacement supersedes omission at the same source path.
  const replacedPaths = new Set(
    changes
      .filter((change) => change.operation === "replace")
      .map(({ path }) => JSON.stringify(path)),
  );
  const preparedChanges = changes.filter(
    ({ operation, path }) =>
      operation !== "remove" || !replacedPaths.has(JSON.stringify(path)),
  );
  const preview = createPreview(
    document as { [key: string]: JsonValue },
    preparedChanges,
  );
  const checked = validateDocument(preview);
  // Trusted values can still be inapplicable to the target's vocabulary type.
  // Retain original warnings (e.g. empty arrays) without duplicating them.
  reportPreviewDiagnostics(result, checked, reporter.report);
  result = reporter.result();
  if (
    !checked.complete ||
    !result.complete ||
    result.diagnostics.some(({ severity }) => severity === "error")
  ) {
    return { ...result, complete: checked.complete && result.complete };
  }
  return {
    ...result,
    diagnostics: result.diagnostics.map((diagnostic) =>
      (diagnostic.reason === "empty_property_list" ||
        diagnostic.reason === "absent_identifier") &&
      replacedPaths.has(JSON.stringify(diagnostic.path))
        ? {
            ...diagnostic,
            message:
              "This absent value is replaced by the trusted server-owned value in the preview.",
          }
        : diagnostic,
    ),
    changes: preparedChanges,
    normalizedDocument: preview,
  };
}
