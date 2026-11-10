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
  type InterpretedNode,
  RELATION_PROPERTIES,
  type RecipientOccurrence,
  type RelationOccurrence,
  interpretDocument,
} from "@drfed/federation/document";
import { schema } from "@drfed/models";
import {
  type Diagnostic,
  type DiagnosticCategory,
  type DiagnosticSeverity,
  type DocumentNodeKind,
  validateDocument,
} from "@drfed/models/document";
import type {
  ResourceRevision as ResourceRevisionRow,
  Resource as ResourceRow,
} from "@drfed/models/schema";
import { and, eq, inArray } from "drizzle-orm";

import builder, { type DrFedObjectRef, type UserContext } from "./builder.ts";
import { readableHistory, readableResource } from "./readable.ts";
import { Resource } from "./resource.ts";

const ACTIVITY_STREAMS = "https://www.w3.org/ns/activitystreams#";

const ResourceRevisionKind = builder.enumType("ResourceRevisionKind", {
  description: "What a revision records.",
  values: {
    snapshot: { description: "A saved document." },
    unavailable: {
      description:
        "A legacy typed row that had no retained document; nothing replaces it.",
    },
    whiteout: {
      description:
        "A deletion: its time and the types the resource had, but no document.",
    },
  } satisfies Record<ResourceRevisionRow["kind"], object>,
});
const ResourceRevisionCapture = builder.enumType("ResourceRevisionCapture", {
  description:
    "How DrFed came to store a revision.  Neither proves ownership nor " +
    "grants access.",
  values: {
    local: { description: "Saved by DrFed for a local actor." },
    received: { description: "Received in an inbound activity." },
    embedded: { description: "Embedded in another received document." },
    fetched: {
      description:
        "Fetched apart from an activity.  For legacy data, a conservative " +
        "flag that is no proof an HTTP fetch occurred.",
    },
  } satisfies Record<ResourceRevisionRow["capture"], object>,
});
const DocumentNodeKindEnum = builder.enumType("DocumentNodeKind", {
  description: "The vocabulary category of a document's type.",
  values: {
    activity: {},
    actor: {},
    collection: {},
    link: {},
    object: {},
  } satisfies Record<DocumentNodeKind, object>,
});
const RelationProperty = builder.enumType("RelationProperty", {
  description: "A property that relates a document to another resource.",
  values: RELATION_PROPERTIES,
});
const AddressingProperty = builder.enumType("AddressingProperty", {
  description: "A property that addresses a document's recipients.",
  values: schema.addressingPropertyEnum.enumValues,
});
const RelationRepresentation = builder.enumType("RelationRepresentation", {
  description: "How a value names what it stands for.",
  values: {
    reference: { description: "An IRI." },
    embedded: { description: "An embedded document." },
    link: { description: "An embedded `Link`, which names it by `href`." },
  } satisfies Record<RelationOccurrence["representation"], object>,
});
const DiagnosticCategoryEnum = builder.enumType("DiagnosticCategory", {
  values: {
    vocabulary: {
      description: "The document breaks a vocabulary or JSON-LD rule.",
    },
    authority: { description: "The document claims what it may not." },
    support: { description: "DrFed's validator cannot check it." },
    compatibility: {
      description: "Valid, but other implementations may read it otherwise.",
    },
  } satisfies Record<DiagnosticCategory, object>,
});
const DiagnosticSeverityEnum = builder.enumType("DiagnosticSeverity", {
  values: {
    error: {},
    warning: {},
  } satisfies Record<DiagnosticSeverity, object>,
});

const DocumentExtension = builder.objectRef<{
  readonly key: string;
  readonly value: unknown;
}>("DocumentExtension");
DocumentExtension.implement({
  description: "A custom extension property, preserved as opaque JSON.",
  fields: (t) => ({
    key: t.exposeString("key", {
      description: "The key in its source spelling.",
    }),
    value: t.expose("value", { type: "JSON", description: "As saved." }),
  }),
});

const DocumentDiagnostic = builder.objectRef<Diagnostic>("DocumentDiagnostic");
DocumentDiagnostic.implement({
  description: "A finding of the document validator.",
  fields: (t) => ({
    reason: t.exposeString("reason", {
      description:
        "A stable classification, such as `unsupported_property`.  Use it " +
        "for decisions rather than `message`.",
    }),
    category: t.expose("category", { type: DiagnosticCategoryEnum }),
    severity: t.expose("severity", { type: DiagnosticSeverityEnum }),
    path: t.expose("path", {
      type: "JSON",
      description:
        "The source keys and list indexes leading to the finding; `[]` is " +
        "the root.",
    }),
    message: t.exposeString("message", {
      description: "For people; it may change.",
    }),
  }),
});

const DocumentNode = builder.objectRef<InterpretedNode>("DocumentNode");
const DocumentRelation =
  builder.objectRef<RelationOccurrence>("DocumentRelation");
const DocumentRecipient =
  builder.objectRef<RecipientOccurrence>("DocumentRecipient");

const resourceLookups = new WeakMap<
  UserContext,
  Map<string, Promise<ResourceRow | null>>
>();

/**
 * Finds the resource registered under an IRI, as `Activity.object` opens
 * it: only when the viewer may read it.  A deleted one is found too, since
 * its revisions stay readable.  Lookups are shared within a request, since
 * a document may name one IRI many times.
 * @returns The resource, or null.
 */
function registeredResource(
  ctx: UserContext,
  iri: string | null,
): Promise<ResourceRow | null> {
  if (iri == null) return Promise.resolve(null);
  let lookups = resourceLookups.get(ctx);
  if (lookups == null) {
    lookups = new Map();
    resourceLookups.set(ctx, lookups);
  }
  let lookup = lookups.get(iri);
  if (lookup == null) {
    lookup = (async () =>
      (await ctx.db.query.resources.findFirst({
        where: {
          iri,
          RAW: (table) => readableResource(ctx, table.id),
        },
      })) ?? null)();
    lookups.set(iri, lookup);
  }
  return lookup;
}

const occurrenceFields = {
  representation: {
    description:
      "Whether the value is an IRI, an embedded document or a `Link`.",
  },
  iri:
    "A reference's IRI, an embedded document's `id`, or a `Link`'s `href`, " +
    "with a compact IRI expanded; null for an anonymous embedded value.",
  resource:
    "The resource currently registered under `iri`, or null when there is " +
    "none, or when the viewer may not read it.  A deleted resource is " +
    "returned too, since its revisions stay readable.  It is never fetched.",
} as const;

DocumentRelation.implement({
  description:
    "One value of a relation property, in source order including duplicates.",
  fields: (t) => ({
    property: t.expose("property", { type: RelationProperty }),
    path: t.expose("path", {
      type: "JSON",
      description:
        "The source path of the value from the root of the saved document, " +
        'such as `["object", 0]`.',
    }),
    representation: t.expose("representation", {
      type: RelationRepresentation,
      ...occurrenceFields.representation,
    }),
    iri: t.expose("iri", {
      type: "URL",
      nullable: true,
      description: occurrenceFields.iri,
    }),
    node: t.expose("node", {
      type: DocumentNode,
      nullable: true,
      description:
        "The embedded document or `Link` as the saved document embeds it, " +
        "which may differ from the resource's current revision; null for a " +
        "reference.",
    }),
    resource: t.field({
      type: Resource,
      nullable: true,
      description: occurrenceFields.resource,
      resolve: (occurrence, _, ctx) => registeredResource(ctx, occurrence.iri),
    }),
  }),
});

DocumentRecipient.implement({
  description:
    "One value of an addressing property, in source order including " +
    "duplicates and anonymous embedded recipients.",
  fields: (t) => ({
    property: t.expose("property", { type: AddressingProperty }),
    position: t.exposeInt("position", {
      description:
        "The index of the value in its property's list, or 0 for a value " +
        "written alone.",
    }),
    path: t.expose("path", {
      type: "JSON",
      description:
        "The source path of the value from the root of the saved document.",
    }),
    representation: t.expose("representation", {
      type: RelationRepresentation,
      ...occurrenceFields.representation,
    }),
    iri: t.expose("iri", {
      type: "URL",
      nullable: true,
      description: occurrenceFields.iri,
    }),
    resource: t.field({
      type: Resource,
      nullable: true,
      description: occurrenceFields.resource,
      resolve: (occurrence, _, ctx) => registeredResource(ctx, occurrence.iri),
    }),
  }),
});

DocumentNode.implement({
  description:
    "A vocabulary document of a saved revision, the root or one embedded in " +
    "it at any depth, read by meaning, whatever keys spell its properties.  " +
    "It may be anonymous.",
  fields: (t) => ({
    path: t.expose("path", {
      type: "JSON",
      description:
        'The source path from the root, such as `["object", 0]`; `[]` is ' +
        "the root.",
    }),
    property: t.exposeString("property", {
      nullable: true,
      description:
        "The standard name of the property that embeds it, whatever its " +
        "source spelling; null for the root.",
    }),
    type: t.expose("type", {
      type: "URL",
      description: "The type IRI, such as `…/activitystreams#Note`.",
    }),
    kind: t.expose("kind", { type: DocumentNodeKindEnum }),
    iri: t.expose("iri", {
      type: "URL",
      nullable: true,
      description:
        "Its `id`, or the `href` of a `Link`, with a compact IRI expanded; " +
        "null when it has none.",
    }),
    document: t.expose("value", {
      type: "JSON",
      description: "Its JSON as saved, with everything it embeds.",
    }),
    relations: t.field({
      type: [DocumentRelation],
      args: { property: t.arg({ type: RelationProperty }) },
      description:
        "Its own `actor`, `object`, `target`, `origin`, `result`, " +
        "`instrument` and `attributedTo` values, or those of one property, " +
        "in that order, then in source order including duplicates.  Empty " +
        "for a property it does not have.",
      resolve: (node, { property }) =>
        property == null
          ? node.relations
          : node.relations.filter((entry) => entry.property === property),
    }),
    addressing: t.field({
      type: [DocumentRecipient],
      args: { property: t.arg({ type: AddressingProperty }) },
      description:
        "Its own `to`, `cc`, `bto`, `bcc` and `audience` values, or those " +
        "of one property, in that order, then in source order including " +
        "duplicates.",
      resolve: (node, { property }) =>
        property == null
          ? node.addressing
          : node.addressing.filter((entry) => entry.property === property),
    }),
    extensions: t.expose("extensions", {
      type: [DocumentExtension],
      description:
        "Its own custom extension properties, by their source keys, sorted.",
    }),
  }),
});

type Content = Pick<ResourceRevisionRow, "kind" | "document">;

const interpretations = new WeakMap<Content, InterpretedNode | null>();
const validations = new WeakMap<Content, readonly Diagnostic[]>();

/**
 * Interprets a revision's document once per loaded row.
 * @returns The root, or null unless the revision is a snapshot whose
 *          document the validator reads without errors.
 */
function rootOf(revision: Content): InterpretedNode | null {
  if (!interpretations.has(revision)) {
    interpretations.set(
      revision,
      revision.kind === "snapshot"
        ? (interpretDocument(revision.document)?.[0] ?? null)
        : null,
    );
  }
  return interpretations.get(revision)!;
}

function diagnosticsOf(revision: Content): readonly Diagnostic[] {
  let diagnostics = validations.get(revision);
  if (diagnostics == null) {
    diagnostics =
      revision.kind === "snapshot"
        ? validateDocument(revision.document).diagnostics
        : [];
    validations.set(revision, diagnostics);
  }
  return diagnostics;
}

const content = { columns: { kind: true, document: true } } as const;

const ResourceRevisionRef = builder.drizzleNode("resourceRevisions", {
  name: "ResourceRevision",
  description:
    "An immutable revision of a resource.  Every revision, past ones " +
    "included, is readable exactly when its resource's history is: a local " +
    "resource's by anyone, blind recipients and unpublished activities " +
    "included; a remote one's as `Activity` and `Object` tell; never one " +
    "hidden by a deletion.  A revision the viewer may not read is left out " +
    "as if it did not exist.",
  // A node lookup checks the revision against its resource.
  select: { columns: { id: true, resourceId: true } },
  id: { column: (revision) => revision.id },
  fields: (t) => ({
    resource: t.relation("resource"),
    sequence: t.exposeInt("sequence", {
      description: "Increases with each revision of the resource.",
    }),
    kind: t.expose("kind", { type: ResourceRevisionKind }),
    capture: t.expose("capture", { type: ResourceRevisionCapture }),
    backfilled: t.exposeBoolean("backfilled", {
      description: "Whether the migration from legacy typed rows created it.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "When DrFed stored the revision.",
    }),
    document: t.expose("document", {
      type: "JSON",
      nullable: true,
      description:
        "The saved JSON as is, `bto` and `bcc` included for local " +
        "resources.  Read `root` instead of parsing it by keys, which " +
        "aliases and contexts may spell otherwise.  Null unless `kind` is " +
        "`snapshot`, or for a snapshot of JSON null.",
    }),
    interpreted: t.boolean({
      description:
        "Whether `root` could be derived from `document`.  When false, " +
        "`root` is null and, for a snapshot, `diagnostics` explain why.",
      select: content,
      resolve: (revision) => rootOf(revision) != null,
    }),
    root: t.field({
      type: DocumentNode,
      nullable: true,
      description:
        "The root document read by meaning; null unless `interpreted`.",
      select: content,
      resolve: (revision) => rootOf(revision),
    }),
    diagnostics: t.field({
      type: [DocumentDiagnostic],
      description:
        "What the current validator finds in the saved document, which may " +
        "differ from what it found when the revision was stored.  Empty " +
        "unless `kind` is `snapshot`.",
      select: content,
      resolve: (revision) => diagnosticsOf(revision),
    }),
    deleted: t.expose("deleted", {
      type: "DateTime",
      nullable: true,
      description: "The deletion time of a whiteout; null otherwise.",
    }),
    formerTypes: t.field({
      type: ["URL"],
      nullable: true,
      description:
        "The type IRIs the resource had, for a whiteout; null otherwise.  " +
        'Stored ActivityStreams names, such as `"Note"`, are expanded with ' +
        "`https://www.w3.org/ns/activitystreams#`.",
      select: { columns: { formerTypes: true } },
      resolve: (revision) =>
        revision.formerTypes?.map((type) =>
          type.includes(":") ? type : `${ACTIVITY_STREAMS}${type}`,
        ) ?? null,
    }),
  }),
});
export const ResourceRevision: DrFedObjectRef = ResourceRevisionRef;

builder.drizzleObjectField("resources", "currentRevision", (t) =>
  t.field({
    type: ResourceRevisionRef,
    nullable: true,
    description:
      "The current revision; null for a resource without revisions, or when " +
      "the viewer may not read the resource's revisions.",
    select: { columns: { id: true } },
    resolve: async (resource, _, ctx) =>
      (await ctx.db.query.resourceRevisions.findFirst({
        where: {
          RAW: (table) =>
            and(
              inArray(
                table.id,
                ctx.db
                  .select({ id: schema.resourceHeads.revisionId })
                  .from(schema.resourceHeads)
                  .where(eq(schema.resourceHeads.resourceId, resource.id)),
              ),
              readableHistory(ctx, table.resourceId),
            )!,
        },
      })) ?? null,
  }),
);

builder.drizzleObjectField("resources", "revisions", (t) =>
  t.relatedConnection(
    "revisions",
    {
      description:
        "Every revision, newest first.  Empty when the viewer may not read " +
        "the resource's revisions.",
      query: (_, ctx) => ({
        where: { RAW: (table) => readableHistory(ctx, table.resourceId) },
        orderBy: { sequence: "desc" },
      }),
    },
    { name: "ResourceRevisionConnection" },
    { name: "ResourceRevisionEdge" },
  ),
);
