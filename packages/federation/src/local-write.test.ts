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

// Writes in one test depend on the state the previous ones left.
// oxlint-disable no-await-in-loop

import assert from "node:assert/strict";

import {
  type CommitOptions,
  type CreateRequest,
  type JsonObject,
  type LocalWriteEnvironment,
  type LocalWriteRequest,
  type SavedResource,
  commitLocalWrite,
  previewLocalWrite,
} from "@drfed/federation/local-write";
import { objectSelection, toObject } from "@drfed/federation/object";
import { type Database, schema } from "@drfed/models";
import { PUBLIC_IRI, ensureResource } from "@drfed/models/resource";
import {
  appendResourceRevision,
  captureLegacyResourceRevision,
  listResourceRevisions,
  loadCurrentResourceRevision,
} from "@drfed/models/resource-revision";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";
import { describe, it } from "@logtape/testing-node/autoload";
import { eq } from "drizzle-orm";

import { withFederation } from "./harness.test.ts";
import {
  created,
  localActorId,
  localInstanceId,
  seedLocalActor,
  seedObjects,
} from "./seed.test.ts";

const AS = "https://www.w3.org/ns/activitystreams";
const ROOT_ORIGIN = new URL("https://drfed.org");
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000301" as Uuid;
const PRINCIPAL = { accountId: ACCOUNT_ID };
const ACTOR_IRI = `https://test-instance.drfed.org/users/${localActorId}`;
const NOTE = {
  "@context": AS,
  type: "Note",
  content: "<p>Hello</p>",
  to: [PUBLIC_IRI],
  bcc: ["https://remote.example/users/blind"],
};

async function seedMember(db: Database, accepted: boolean = true) {
  await seedLocalActor(db, { keys: false });
  await db.insert(schema.accounts).values({
    id: ACCOUNT_ID,
    email: "member@example.com",
    name: "Member",
    created,
  });
  await db.insert(schema.instanceMembers).values({
    accountId: ACCOUNT_ID,
    instanceId: localInstanceId,
    accepted: accepted ? created : null,
    created,
  });
}

async function environment(
  harness: Parameters<Parameters<typeof withFederation>[0]>[0],
): Promise<LocalWriteEnvironment> {
  return {
    db: harness.db,
    federation: harness.federation,
    rootOrigin: ROOT_ORIGIN,
    previewKey: await crypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ),
  };
}

const tables = [
  schema.resources,
  schema.resourceRevisions,
  schema.resourceHeads,
  schema.revisionAddressing,
  schema.revisionRelations,
  schema.addressing,
  schema.objects,
  schema.activities,
  schema.collectionItems,
  schema.activityDeliveries,
] as const;

async function counts(db: Database): Promise<number[]> {
  const result: number[] = [];
  for (const table of tables) result.push(await db.$count(table));
  return result;
}

function create(
  document: CreateRequest["document"],
  resources: CreateRequest["resources"] = [{ path: [], kind: "object" }],
  extra: Partial<CreateRequest> = {},
): CreateRequest {
  return {
    operation: "create",
    actorId: localActorId,
    document,
    resources,
    ...extra,
  };
}

async function save(
  env: LocalWriteEnvironment,
  request: CreateRequest,
  reserveDispatch?: (activity: SavedResource) => Promise<void>,
) {
  const preview = await previewLocalWrite(env, PRINCIPAL, request);
  assert.ok(preview.ok, JSON.stringify(!preview.ok && preview.error));
  const outcome = await commitLocalWrite(env, PRINCIPAL, request, {
    previewToken: preview.preview.token,
    ...(reserveDispatch == null
      ? {}
      : { reserveDispatch: (_tx, activity) => reserveDispatch(activity) }),
  });
  assert.ok(outcome.ok, JSON.stringify(!outcome.ok && outcome.error));
  return { preview: preview.preview, result: outcome.result };
}

describe("previewLocalWrite() and commitLocalWrite()", () => {
  it("saves an object alone, without an activity, outbox entry, or delivery", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const before = await counts(harness.db);
      const preview = await previewLocalWrite(env, PRINCIPAL, create(NOTE));
      assert.ok(preview.ok);
      assert.deepEqual(await counts(harness.db), before);
      const [prepared] = preview.preview.resources;
      assert.ok(prepared != null);
      assert.match(
        prepared.iri,
        new RegExp(`^${ACTOR_IRI}/[0-9a-f-]{36}$`, "u"),
      );
      assert.equal(prepared.document.id, prepared.iri);
      assert.equal(prepared.document.attributedTo, ACTOR_IRI);
      assert.equal(typeof prepared.document.published, "string");
      assert.deepEqual(
        preview.preview.changes
          .map(({ path, reason }) => [path.join("."), reason])
          .toSorted(),
        [
          ["attributedTo", "assign_server_owned_field"],
          ["id", "assign_server_owned_field"],
          ["published", "assign_server_owned_field"],
        ],
      );
      const outcome = await commitLocalWrite(env, PRINCIPAL, create(NOTE), {
        previewToken: preview.preview.token,
      });
      assert.ok(outcome.ok);
      const [saved] = outcome.result.resources;
      assert.ok(saved != null);
      assert.deepEqual(saved.document, prepared.document);
      const revision = await loadCurrentResourceRevision(harness.db, saved.id);
      assert.equal(revision?.capture, "local");
      assert.deepEqual(revision?.document, prepared.document);
      assert.deepEqual(
        revision?.addressing.map(({ property, iri }) => [property, iri]),
        [
          ["to", PUBLIC_IRI],
          ["bcc", "https://remote.example/users/blind"],
        ],
      );
      const resource = await harness.db.query.resources.findFirst({
        where: { id: saved.id },
      });
      assert.equal(resource?.kind, "object");
      // Revision-only, without legacy typed rows; nothing else changed.
      assert.equal(await harness.db.$count(schema.objects), 0);
      assert.equal(await harness.db.$count(schema.activities), 0);
      assert.equal(await harness.db.$count(schema.collectionItems), 0);
      assert.equal(await harness.db.$count(schema.activityDeliveries), 0);
      assert.equal(
        await harness.db.$count(
          schema.addressing,
          eq(schema.addressing.sourceId, saved.id),
        ),
        2,
      );
    });
  });

  it("saves objects of other types, including a Question as an object", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      for (const document of [
        { "@context": AS, type: "Object", name: "Plain" },
        { "@context": AS, type: "Question", name: "Open question" },
      ]) {
        const { result } = await save(env, create(document));
        assert.match(
          result.resources[0]!.iri,
          new RegExp(`^${ACTOR_IRI}/`, "u"),
        );
      }
    });
  });

  it("saves an activity referring to an existing object and an external IRI without touching them", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { result: first } = await save(env, create(NOTE));
      const noteResource = first.resources[0]!;
      const like = {
        "@context": AS,
        type: "Like",
        object: noteResource.iri,
        instrument: "https://remote.example/objects/1",
        to: [PUBLIC_IRI],
      };
      const { result } = await save(
        env,
        create(like, [{ path: [], kind: "activity" }]),
      );
      const saved = result.resources[0]!;
      assert.match(
        saved.iri,
        /^https:\/\/test-instance\.drfed\.org\/ap\/activities\//u,
      );
      assert.equal(saved.document.actor, ACTOR_IRI);
      assert.equal(saved.document.object, noteResource.iri);
      assert.deepEqual(
        saved.relations.map(({ property, representation, targetIri }) => [
          property,
          representation,
          targetIri,
        ]),
        [
          ["actor", "reference", ACTOR_IRI],
          ["object", "reference", noteResource.iri],
          ["instrument", "reference", "https://remote.example/objects/1"],
        ],
      );
      assert.equal(
        (await listResourceRevisions(harness.db, noteResource.id)).length,
        1,
      );
      const external = await harness.db.query.resources.findFirst({
        where: { iri: "https://remote.example/objects/1" },
      });
      // Only addressing registers IRIs; a mere reference is not stored.
      assert.equal(external, undefined);
      assert.equal(await harness.db.$count(schema.collectionItems), 0);
    });
  });

  it("creates a Create with a new Note, embedded or by reference, atomically", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const document = {
        "@context": AS,
        type: "Create",
        to: [PUBLIC_IRI],
        object: { type: "Note", content: "<p>Nested</p>", to: [PUBLIC_IRI] },
      };
      for (const representation of ["embedded", "reference"] as const) {
        const { preview, result } = await save(
          env,
          create(document, [
            { path: [], kind: "activity" },
            { path: ["object"], kind: "object", representation },
          ]),
        );
        const [nested, root] = result.resources;
        assert.ok(nested != null && root != null);
        assert.match(root.iri, /\/ap\/creates\/[0-9a-f-]{36}$/u);
        assert.equal(nested.document.id, nested.iri);
        assert.equal(nested.document.attributedTo, ACTOR_IRI);
        assert.equal(nested.document.published, root.document.published);
        if (representation === "embedded") {
          const { "@context": _, ...embedded } = nested.document;
          assert.deepEqual(root.document.object, embedded);
        } else {
          assert.equal(root.document.object, nested.iri);
          assert.ok(
            preview.changes.some(
              ({ reason, path }) =>
                reason === "reference_created_resource" &&
                JSON.stringify(path) === '["object"]',
            ),
          );
        }
        for (const resource of [nested, root]) {
          assert.equal(
            (await loadCurrentResourceRevision(harness.db, resource.id))
              ?.sequence,
            1,
          );
        }
      }
    });
  });

  it("creates nested activities through the same path, as in Undo of a new Like", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { result } = await save(
        env,
        create(
          {
            "@context": AS,
            type: "Undo",
            object: { type: "Like", object: "https://remote.example/notes/1" },
          },
          [
            { path: [], kind: "activity" },
            { path: ["object"], kind: "activity" },
          ],
        ),
      );
      const [like, undo] = result.resources;
      assert.equal(like?.document.actor, ACTOR_IRI);
      assert.match(like!.iri, /\/ap\/activities\//u);
      assert.equal(
        (undo?.document.object as { id?: string } | undefined)?.id,
        like?.iri,
      );
    });
  });

  it("carries the effective context, aliases included, into nested documents", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const context = [AS, { payload: { "@id": "as:object", "@type": "@id" } }];
      const { preview, result } = await save(
        env,
        create(
          {
            "@context": context,
            type: "Create",
            payload: {
              "@context": { headline: "as:name" },
              type: "Note",
              headline: "Aliased",
              content: "x",
            },
          },
          [
            { path: [], kind: "activity" },
            { path: ["payload"], kind: "object" },
          ],
        ),
      );
      const [nested, root] = result.resources;
      assert.deepEqual(nested?.document["@context"], [
        ...context,
        { headline: "as:name" },
      ]);
      assert.deepEqual(
        root?.relations.map(({ property, path }) => [property, path]),
        [
          ["actor", ["actor"]],
          ["object", ["payload"]],
        ],
      );
      assert.ok(
        preview.changes.some(
          ({ reason }) => reason === "materialize_effective_context",
        ),
      );
    });
  });

  it("states the implicit ActivityStreams context in nested documents", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { preview, result } = await save(
        env,
        create({ type: "Create", object: { type: "Note", content: "a" } }, [
          { path: [], kind: "activity" },
          { path: ["object"], kind: "object" },
        ]),
      );
      assert.equal(result.resources[0]?.document["@context"], AS);
      assert.ok(
        preview.changes.some(
          ({ operation, reason, path }) =>
            operation === "add" &&
            reason === "materialize_effective_context" &&
            JSON.stringify(path) === '["object","@context"]',
        ),
      );
    });
  });

  it("refuses several spellings of one indexed property", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const outcome = await previewLocalWrite(
        env,
        PRINCIPAL,
        create({
          "@context": [AS, { recipients: { "@id": "as:to", "@type": "@id" } }],
          type: "Note",
          content: "x",
          to: ["https://remote.example/a"],
          recipients: [PUBLIC_IRI],
        }),
      );
      assert.ok(!outcome.ok);
      assert.equal(outcome.error.type, "invalid_document");
      assert.deepEqual(
        outcome.error.diagnostics.map(({ reason, path }) => [reason, path]),
        [["unsupported_value_form", ["to"]]],
      );
    });
  });

  it("handles a nested resource under a key spelled __proto__ as an own property", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      // JSON.parse, unlike an object literal, makes __proto__ an own key.
      const document = JSON.parse(
        JSON.stringify({
          "@context": [AS, { payload: { "@id": "as:object", "@type": "@id" } }],
          type: "Create",
          payload: { type: "Note", content: "x" },
        }).replaceAll("payload", "__proto__"),
      ) as JsonObject;
      const { result } = await save(
        env,
        create(document, [
          { path: [], kind: "activity" },
          { path: ["__proto__"], kind: "object", representation: "reference" },
        ]),
      );
      const [nested, root] = result.resources;
      assert.ok(nested != null && root != null);
      assert.ok(Object.hasOwn(root.document, "__proto__"));
      assert.equal(
        Object.getOwnPropertyDescriptor(root.document, "__proto__")?.value,
        nested.iri,
      );
      assert.equal(Object.getPrototypeOf(root.document), Object.prototype);
      assert.equal(({} as Record<string, unknown>).type, undefined);
    });
  });

  it("keeps addressing occurrences at their source positions", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { result } = await save(
        env,
        create({
          "@context": AS,
          type: "Note",
          content: "x",
          to: [
            "as:Public",
            { type: "Link", href: "https://remote.example/users/link" },
            { type: "Object", name: "anonymous" },
            "https://remote.example/users/last",
          ],
        }),
      );
      assert.deepEqual(result.resources[0]?.addressing, [
        { property: "to", position: 0, iri: PUBLIC_IRI },
        {
          property: "to",
          position: 1,
          iri: "https://remote.example/users/link",
        },
        {
          property: "to",
          position: 3,
          iri: "https://remote.example/users/last",
        },
      ]);
    });
  });

  it("refuses local identity claims the actor may not make, however they are spelled", async () => {
    await withFederation(async (harness) => {
      const OTHER = "https://other.drfed.org/users/victim";
      await seedMember(harness.db);
      const env = await environment(harness);
      for (const [document, path] of [
        [
          {
            "@context": AS,
            type: "Undo",
            object: {
              type: "Like",
              actor: OTHER,
              object: "https://x.example/",
            },
          },
          ["object", "actor"],
        ],
        [
          {
            "@context": [
              AS,
              {
                by: { "@id": "as:actor", "@type": "@id" },
                local: {
                  "@id": "https://other.drfed.org/users/",
                  "@prefix": true,
                },
              },
            ],
            type: "Undo",
            object: {
              type: "Like",
              by: "local:victim",
              object: "https://x.example/",
            },
          },
          ["object", "by"],
        ],
        [
          {
            "@context": AS,
            type: "Undo",
            object: {
              type: "Like",
              id: "https://test-instance.drfed.org/ap/activities/forged",
              object: "https://x.example/",
            },
          },
          ["object", "id"],
        ],
      ] as const) {
        const before = await counts(harness.db);
        const outcome = await previewLocalWrite(
          env,
          PRINCIPAL,
          create(document as never, [{ path: [], kind: "activity" }]),
        );
        assert.ok(!outcome.ok);
        assert.equal(outcome.error.type, "invalid_document");
        assert.deepEqual(
          outcome.error.diagnostics
            .filter(({ category }) => category === "authority")
            .map(({ reason, path: found }) => [reason, found]),
          [["unauthorized_local_identity", path]],
        );
        assert.deepEqual(await counts(harness.db), before);
      }
      // A new resource's attribution property that the server does not own
      // is a claim too.
      for (const [document, resources, path] of [
        [
          {
            "@context": AS,
            type: "Like",
            attributedTo: OTHER,
            object: "https://x.example/",
          },
          [{ path: [], kind: "activity" }],
          ["attributedTo"],
        ],
        [
          {
            "@context": AS,
            type: "Undo",
            object: {
              type: "Like",
              attributedTo: OTHER,
              object: "https://x.example/",
            },
          },
          [
            { path: [], kind: "activity" },
            { path: ["object"], kind: "activity" },
          ],
          ["object", "attributedTo"],
        ],
        [
          { "@context": AS, type: "Question", name: "q", actor: OTHER },
          [{ path: [], kind: "object" }],
          ["actor"],
        ],
      ] as const) {
        const outcome = await previewLocalWrite(
          env,
          PRINCIPAL,
          create(document as never, resources as never),
        );
        assert.ok(!outcome.ok);
        assert.deepEqual(
          outcome.error.diagnostics
            .filter(({ category }) => category === "authority")
            .map(({ reason, path: found }) => [reason, found]),
          [["unauthorized_local_identity", path]],
        );
      }
      // A claim of the acting actor itself, or a remote actor, is allowed.
      for (const actor of [ACTOR_IRI, "https://remote.example/users/bob"]) {
        await save(
          env,
          create(
            {
              "@context": AS,
              type: "Undo",
              object: { type: "Like", actor, object: "https://x.example/" },
            },
            [{ path: [], kind: "activity" }],
          ),
        );
      }
      // A new resource's own server-owned fields must match the server.
      const conflict = await previewLocalWrite(
        env,
        PRINCIPAL,
        create({ ...NOTE, attributedTo: "https://remote.example/users/bob" }),
      );
      assert.ok(!conflict.ok);
      assert.ok(
        conflict.error.diagnostics.some(
          ({ reason }) => reason === "server_owned_field_conflict",
        ),
      );
    });
  });

  it("checks identity claims in the node objects of extension values", async () => {
    await withFederation(async (harness) => {
      const LINK = "https://remote.example/links/1";
      const VICTIM = "https://other.drfed.org/users/victim";
      const FORGED = "https://test-instance.drfed.org/users/x/forged";
      await seedMember(harness.db);
      const env = await environment(harness);
      const quoting = (quoted: Record<string, unknown>) =>
        create(
          {
            "@context": [AS, { ex: "https://ext.example/ns#" }],
            type: "Like",
            object: "https://x.example/",
            "ex:quoted": quoted,
          } as never,
          [{ path: [], kind: "activity" }],
        );
      for (const [quoted, path] of [
        [
          {
            type: "Note",
            id: "https://test-instance.drfed.org/users/x/forged",
            content: "forged",
          },
          ["ex:quoted", "id"],
        ],
        [
          {
            type: "Note",
            attributedTo: "https://other.drfed.org/users/victim",
            content: "forged",
          },
          ["ex:quoted", "attributedTo"],
        ],
        [
          {
            type: "Note",
            attributedTo: {
              type: "Link",
              href: "https://other.drfed.org/users/victim",
            },
          },
          ["ex:quoted", "attributedTo", "href"],
        ],
      ] as const) {
        const outcome = await previewLocalWrite(
          env,
          PRINCIPAL,
          quoting(quoted),
        );
        assert.ok(!outcome.ok);
        assert.deepEqual(
          outcome.error.type === "invalid_document"
            ? outcome.error.diagnostics
                .filter(({ category }) => category === "authority")
                .map(({ reason, path: found }) => [reason, found])
            : outcome.error.type,
          [["unauthorized_local_identity", path]],
        );
      }
      // A reference names what a Link embedded elsewhere with its id does.
      for (const [request, path] of [
        [
          create(
            {
              "@context": AS,
              type: "Like",
              object: { type: "Note", content: "forged", attributedTo: LINK },
              target: { type: "Link", id: LINK, href: VICTIM },
            },
            [{ path: [], kind: "activity" }],
          ),
          ["target", "href"],
        ],
        [
          create(
            {
              "@context": [AS, { ex: "https://ext.example/ns#" }],
              type: "Like",
              object: "https://x.example/",
              "ex:quoted": [
                { type: "Note", attributedTo: LINK },
                { id: LINK, type: "Link", href: VICTIM },
              ],
            } as never,
            [{ path: [], kind: "activity" }],
          ),
          ["ex:quoted", 1, "href"],
        ],
        ...[{ id: "_:author" }, "_:author"].map(
          (author) =>
            [
              create(
                {
                  "@context": [AS, { ex: "https://ext.example/ns#" }],
                  type: "Like",
                  object: "https://x.example/",
                  "ex:quoted": [
                    { type: "Note", attributedTo: author },
                    { id: "_:author", type: "Link", href: VICTIM },
                  ],
                } as never,
                [{ path: [], kind: "activity" }],
              ),
              ["ex:quoted", 1, "href"],
            ] as const,
        ),
      ] as const) {
        const outcome = await previewLocalWrite(env, PRINCIPAL, request);
        assert.ok(!outcome.ok, JSON.stringify(request.document));
        assert.deepEqual(
          outcome.error.type === "invalid_document"
            ? outcome.error.diagnostics
                .filter(({ category }) => category === "authority")
                .map(({ reason, path: found }) => [reason, found])
            : outcome.error.type,
          [["unauthorized_local_identity", path]],
        );
      }
      // A Link whose href is its own id claims it through both; each path
      // is denied once.
      const self = await previewLocalWrite(
        env,
        PRINCIPAL,
        quoting({
          type: "Note",
          attributedTo: { type: "Link", id: FORGED, href: FORGED },
        }),
      );
      assert.ok(!self.ok);
      assert.deepEqual(
        self.error.type === "invalid_document"
          ? self.error.diagnostics
              .filter(({ category }) => category === "authority")
              .map(({ reason, path }) => [reason, path])
          : self.error.type,
        [
          [
            "unauthorized_local_identity",
            ["ex:quoted", "attributedTo", "href"],
          ],
          ["unauthorized_local_identity", ["ex:quoted", "attributedTo", "id"]],
        ],
      );
      // A remote identity is not checked, as in any embedded document.
      await save(
        env,
        quoting({
          type: "Note",
          id: "https://remote.example/notes/1",
          attributedTo: "https://remote.example/users/bob",
        }),
      );
    });
  });

  it("does not accept an id that is registered only as a reference", async () => {
    await withFederation(async (harness) => {
      const FORGED = "https://test-instance.drfed.org/ap/activities/forged";
      await seedMember(harness.db);
      const env = await environment(harness);
      const request = create(
        {
          "@context": AS,
          type: "Undo",
          object: { type: "Like", id: FORGED, object: "https://x.example/" },
        },
        [{ path: [], kind: "activity" }],
      );
      const refused = async () => {
        const outcome = await previewLocalWrite(env, PRINCIPAL, request);
        assert.ok(!outcome.ok);
        assert.deepEqual(
          outcome.error.type === "invalid_document"
            ? outcome.error.diagnostics
                .filter(({ category }) => category === "authority")
                .map(({ reason, path }) => [reason, path])
            : outcome.error.type,
          [["unauthorized_local_identity", ["object", "id"]]],
        );
      };
      await refused();
      // Addressing the IRI registers it, but only as a reference.
      await save(env, create({ ...NOTE, to: FORGED }));
      const registered = await harness.db.query.resources.findFirst({
        where: { iri: FORGED },
      });
      assert.equal(registered?.kind, "unknown");
      await refused();
    });
  });

  it("checks membership on every preview and commit", async () => {
    for (const scenario of ["pending", "missing", "expired", "deleted"]) {
      await withFederation(async (harness) => {
        await seedMember(harness.db, scenario !== "pending");
        const env = await environment(harness);
        const preview = await previewLocalWrite(env, PRINCIPAL, create(NOTE));
        assert.ok(scenario === "pending" ? !preview.ok : preview.ok);
        if (scenario === "missing") {
          await harness.db.delete(schema.instanceMembers);
        } else if (scenario === "expired") {
          await harness.db
            .update(schema.localInstances)
            .set({ expires: created });
        } else if (scenario === "deleted") {
          await harness.db
            .update(schema.actors)
            .set({ deleted: created })
            .where(eq(schema.actors.id, localActorId));
        }
        const before = await counts(harness.db);
        const outcome = await commitLocalWrite(env, PRINCIPAL, create(NOTE), {
          previewToken: preview.ok ? preview.preview.token : "invalid",
        });
        assert.ok(!outcome.ok);
        assert.equal(
          outcome.error.type,
          scenario === "pending" ? "stale_preview" : "actor_not_found",
        );
        assert.deepEqual(await counts(harness.db), before);
      });
    }
  });

  it("commits only the values of a matching, unexpired token, once", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const request = create(NOTE);
      const preview = await previewLocalWrite(env, PRINCIPAL, request);
      assert.ok(preview.ok);
      const { token } = preview.preview;
      const [body, signature] = token.split(".");
      const forged = JSON.parse(Buffer.from(body!, "base64url").toString());
      forged.timestamp = "2000-01-01T00:00:00Z";
      for (const [previewToken, changed, expected] of [
        ["", request, "invalid_request"],
        [`${body}.${signature}x`, request, "stale_preview"],
        [
          `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`,
          request,
          "stale_preview",
        ],
        [token, create({ ...NOTE, content: "changed" }), "stale_preview"],
      ] as const) {
        const outcome = await commitLocalWrite(env, PRINCIPAL, changed, {
          previewToken,
        });
        assert.ok(!outcome.ok);
        assert.equal(outcome.error.type, expected);
      }
      const other = await commitLocalWrite(
        env,
        { accountId: uuidV7() },
        request,
        { previewToken: token },
      );
      assert.ok(!other.ok);
      assert.equal(other.error.type, "stale_preview");
      const first = await commitLocalWrite(env, PRINCIPAL, request, {
        previewToken: token,
      });
      assert.ok(first.ok);
      assert.deepEqual(
        first.result.resources[0]?.document,
        preview.preview.resources[0]?.document,
      );
      const before = await counts(harness.db);
      const replay = await commitLocalWrite(env, PRINCIPAL, request, {
        previewToken: token,
      });
      assert.ok(!replay.ok);
      assert.equal(replay.error.type, "resource_conflict");
      assert.deepEqual(await counts(harness.db), before);
    });
  });

  it("publishes only with a reservation, and rolls everything back when it fails", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const request = create(
        {
          "@context": AS,
          type: "Create",
          to: [PUBLIC_IRI],
          object: { type: "Note", content: "x", to: [PUBLIC_IRI] },
        },
        [
          { path: [], kind: "activity" },
          { path: ["object"], kind: "object" },
        ],
        { publish: true },
      );
      const preview = await previewLocalWrite(env, PRINCIPAL, request);
      assert.ok(preview.ok);
      const { token: previewToken } = preview.preview;
      const missing = await commitLocalWrite(env, PRINCIPAL, request, {
        previewToken,
      });
      assert.ok(!missing.ok);
      assert.equal(missing.error.type, "invalid_request");
      const before = await counts(harness.db);
      await assert.rejects(
        commitLocalWrite(env, PRINCIPAL, request, {
          previewToken,
          reserveDispatch: () => Promise.reject(new Error("queue down")),
        }),
        /queue down/u,
      );
      assert.deepEqual(await counts(harness.db), before);
      const reserved: SavedResource[] = [];
      const retried = await commitLocalWrite(env, PRINCIPAL, request, {
        previewToken,
        reserveDispatch: (_tx, activity) => {
          reserved.push(activity);
          return Promise.resolve();
        },
      });
      assert.ok(retried.ok);
      const root = retried.result.resources.at(-1)!;
      assert.deepEqual(reserved, [root]);
      const items = await harness.db.query.collectionItems.findMany();
      assert.deepEqual(
        items.map(({ itemId }) => itemId),
        [root.id],
      );
      // Saved without a legacy typed row; it is served from its revision.
      assert.equal(await harness.db.$count(schema.activities), 0);
    });
  });

  it("rejects malformed descriptors before anything else", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const document = {
        "@context": AS,
        type: "Create",
        object: {
          type: "Note",
          content: "x",
          attachment: null,
        },
      };
      for (const [resources, extra] of [
        [[], {}],
        [[{ path: ["object"], kind: "object" }], {}],
        [
          [
            { path: [], kind: "activity" },
            { path: [], kind: "activity" },
          ],
          {},
        ],
        [[{ path: [], kind: "object" }], {}],
        [[{ path: [], kind: "activity", representation: "reference" }], {}],
        [
          [
            { path: [], kind: "activity" },
            { path: ["object", "content"], kind: "object" },
          ],
          {},
        ],
        [
          [
            { path: [], kind: "activity" },
            { path: ["object"], kind: "activity" },
          ],
          {},
        ],
        [[{ path: [], kind: "activity" }], { publish: "yes" }],
        [[{ path: [], kind: "nothing" }], {}],
      ] as const) {
        const outcome = await previewLocalWrite(
          env,
          PRINCIPAL,
          create(document, resources as never, extra as never),
        );
        assert.ok(!outcome.ok, JSON.stringify(resources));
        assert.equal(outcome.error.type, "invalid_request");
      }
      const publishedObject = await previewLocalWrite(
        env,
        PRINCIPAL,
        create(NOTE, [{ path: [], kind: "object" }], { publish: true }),
      );
      assert.ok(!publishedObject.ok);
      assert.equal(publishedObject.error.type, "invalid_request");
    });
  });
});

/**
 * Seeds a Note the way the legacy createObject mutation stores one.
 * @returns Its IDs, IRI, and current revision.
 */
async function seedLegacyNote(
  harness: Parameters<Parameters<typeof withFederation>[0]>[0],
  addressing: Record<string, string[]> = {
    to: [PUBLIC_IRI],
    cc: [],
    bto: [],
    bcc: ["https://remote.example/users/blind"],
    audience: [],
  },
) {
  const id = uuidV7();
  const activityId = uuidV7();
  await seedObjects(harness.db, {
    id,
    activityId,
    actorId: localActorId,
    iri: `${ACTOR_IRI}/${id}`,
    type: "Note",
    contentHtml: "<p>First</p>",
    language: "en",
    addressing,
  });
  const ctx = harness.federation.createContext(
    new URL("https://test-instance.drfed.org"),
    undefined,
  );
  const stored = await harness.db.query.objects.findFirst({
    where: { id },
    with: objectSelection,
  });
  assert.ok(stored != null);
  const document = {
    ...((await toObject(ctx, stored).toJsonLd()) as Record<string, unknown>),
    ...addressing,
  };
  await harness.db
    .update(schema.objects)
    .set({ document, updated: stored.updated })
    .where(eq(schema.objects.id, id));
  await harness.db.transaction(async (tx) => {
    await captureLegacyResourceRevision(tx, id);
    await captureLegacyResourceRevision(tx, activityId);
  });
  const head = await loadCurrentResourceRevision(harness.db, id);
  assert.ok(head != null);
  return { id, activityId, iri: `${ACTOR_IRI}/${id}`, head };
}

async function current(db: Database, id: Uuid) {
  const head = await loadCurrentResourceRevision(db, id);
  assert.ok(head != null);
  return head;
}

const reserve = () => Promise.resolve();

async function change(
  env: LocalWriteEnvironment,
  request: LocalWriteRequest,
  reserveDispatch: CommitOptions["reserveDispatch"] = reserve,
) {
  const preview = await previewLocalWrite(env, PRINCIPAL, request);
  assert.ok(preview.ok, JSON.stringify(!preview.ok && preview.error));
  const outcome = await commitLocalWrite(env, PRINCIPAL, request, {
    previewToken: preview.preview.token,
    ...(reserveDispatch == null ? {} : { reserveDispatch }),
  });
  assert.ok(outcome.ok, JSON.stringify(!outcome.ok && outcome.error));
  return { preview: preview.preview, result: outcome.result };
}

function edit(
  objectId: Uuid,
  expectedRevisionId: Uuid,
  document: JsonObject,
): LocalWriteRequest {
  return {
    operation: "edit",
    actorId: localActorId,
    objectId,
    expectedRevisionId,
    document,
  };
}

function remove(objectId: Uuid, expectedRevisionId: Uuid): LocalWriteRequest {
  return {
    operation: "delete",
    actorId: localActorId,
    objectId,
    expectedRevisionId,
  };
}

describe("edits and deletions of current objects", () => {
  it("edits a Note twice from what it loads, leaving the earlier Create intact", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { result: initial } = await save(
        env,
        create(
          {
            "@context": AS,
            type: "Create",
            to: [PUBLIC_IRI],
            object: {
              type: "Note",
              content: "A",
              to: [PUBLIC_IRI],
              bcc: ["https://remote.example/users/blind"],
            },
          },
          [
            { path: [], kind: "activity" },
            { path: ["object"], kind: "object" },
          ],
        ),
      );
      const [noteResource, createResource] = initial.resources;
      assert.ok(noteResource != null && createResource != null);
      const reserved: SavedResource[] = [];
      let head = await current(harness.db, noteResource.id);
      for (const content of ["B", "C"]) {
        const { preview, result } = await change(
          env,
          edit(noteResource.id, head.id, {
            ...(head.document as JsonObject),
            content,
          }),
          (_tx, activity) => {
            reserved.push(activity);
            return Promise.resolve();
          },
        );
        assert.equal(preview.currentRevisionId, head.id);
        const [version, update] = result.resources;
        assert.equal(version?.document.content, content);
        assert.equal(version?.document.id, noteResource.iri);
        assert.equal(
          version?.document.published,
          noteResource.document.published,
        );
        assert.equal(typeof version?.document.updated, "string");
        assert.equal(update?.generated, true);
        assert.equal(update?.document.type, "Update");
        assert.equal(update?.document.actor, ACTOR_IRI);
        const { "@context": _, ...embedded } = version!.document;
        assert.deepEqual(update?.document.object, embedded);
        assert.deepEqual(update?.document.bcc, [
          "https://remote.example/users/blind",
        ]);
        assert.equal(reserved.at(-1)?.id, update?.id);
        head = await current(harness.db, noteResource.id);
        assert.equal(head.id, version?.revisionId);
      }
      assert.equal(head.sequence, 3);
      // The Create keeps the version it embedded when it was saved.
      const createHead = await current(harness.db, createResource.id);
      assert.equal(
        (createHead.document as { object: { content: string } }).object.content,
        "A",
      );
      const outbox = await harness.db.query.collectionItems.findMany();
      assert.deepEqual(
        outbox.map(({ itemId }) => itemId).toSorted(),
        reserved.map(({ id }) => id).toSorted(),
      );
    });
  });

  it("accepts the expected revision ID in uppercase", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { result } = await save(env, create(NOTE));
      const saved = result.resources[0]!;
      const head = await current(harness.db, saved.id);
      const { result: edited } = await change(
        env,
        edit(saved.id, head.id.toUpperCase() as Uuid, {
          ...(head.document as JsonObject),
          content: "B",
        }),
      );
      assert.equal(edited.resources[0]?.document.content, "B");
    });
  });

  it("refuses stale, retyped, foreign, and unreserved edits without changes", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { result } = await save(env, create(NOTE));
      const saved = result.resources[0]!;
      const head = await current(harness.db, saved.id);
      const document = head.document as JsonObject;
      const before = await counts(harness.db);
      const stale = await previewLocalWrite(
        env,
        PRINCIPAL,
        edit(saved.id, uuidV7(), document),
      );
      assert.ok(!stale.ok);
      assert.equal(stale.error.type, "revision_conflict");
      const retyped = await previewLocalWrite(
        env,
        PRINCIPAL,
        edit(saved.id, head.id, { ...document, type: "Article" }),
      );
      assert.ok(!retyped.ok);
      assert.equal(retyped.error.type, "unsupported_edit");
      const preview = await previewLocalWrite(
        env,
        PRINCIPAL,
        edit(saved.id, head.id, { ...document, content: "B" }),
      );
      assert.ok(preview.ok);
      const unreserved = await commitLocalWrite(
        env,
        PRINCIPAL,
        edit(saved.id, head.id, { ...document, content: "B" }),
        { previewToken: preview.preview.token },
      );
      assert.ok(!unreserved.ok);
      assert.equal(unreserved.error.type, "invalid_request");
      await assert.rejects(
        commitLocalWrite(
          env,
          PRINCIPAL,
          edit(saved.id, head.id, { ...document, content: "B" }),
          {
            previewToken: preview.preview.token,
            reserveDispatch: () => Promise.reject(new Error("queue down")),
          },
        ),
        /queue down/u,
      );
      assert.deepEqual(await counts(harness.db), before);
      // Another edit committed after the preview wins.
      await change(env, edit(saved.id, head.id, { ...document, content: "C" }));
      const late = await commitLocalWrite(
        env,
        PRINCIPAL,
        edit(saved.id, head.id, { ...document, content: "B" }),
        { previewToken: preview.preview.token, reserveDispatch: reserve },
      );
      assert.ok(!late.ok);
      assert.equal(late.error.type, "revision_conflict");

      // An object attributed to someone else is not the actor's to edit.
      const foreign = await ensureResource(
        harness.db,
        `${ACTOR_IRI}/${uuidV7()}`,
      );
      const foreignHead = await appendResourceRevision(harness.db, {
        resourceId: foreign.id,
        resourceKind: "object",
        expectedRevisionId: null,
        kind: "snapshot",
        capture: "local",
        document: {
          "@context": AS,
          id: foreign.iri,
          type: "Note",
          content: "x",
          attributedTo: "https://remote.example/users/bob",
        },
      });
      const notOwned = await previewLocalWrite(
        env,
        PRINCIPAL,
        edit(foreign.id, foreignHead.id, {
          "@context": AS,
          type: "Note",
          content: "y",
        }),
      );
      assert.ok(!notOwned.ok);
      assert.equal(notOwned.error.type, "unsupported_edit");
    });
  });

  it("refuses an edited version that spells one indexed property twice", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { result } = await save(
        env,
        create({
          "@context": [AS, { hidden: { "@id": "as:bcc", "@type": "@id" } }],
          type: "Note",
          content: "x",
          bcc: ["https://remote.example/users/one"],
        }),
      );
      const saved = result.resources[0]!;
      const head = await current(harness.db, saved.id);
      const outcome = await previewLocalWrite(
        env,
        PRINCIPAL,
        edit(saved.id, head.id, {
          ...(head.document as JsonObject),
          hidden: ["https://remote.example/users/two"],
        }),
      );
      assert.ok(!outcome.ok);
      assert.deepEqual(
        outcome.error.diagnostics.map(({ reason, path }) => [reason, path]),
        [["unsupported_value_form", ["hidden"]]],
      );
    });
  });

  it("edits and deletes documents that spell their keywords and fields by aliases", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { result } = await save(
        env,
        create({
          "@context": [
            AS,
            {
              pub: { "@id": "as:published", "@type": "xsd:dateTime" },
              xsd: "http://www.w3.org/2001/XMLSchema#",
            },
          ],
          "@type": "Note",
          content: "x",
          pub: null,
        }),
      );
      const saved = result.resources[0]!;
      assert.equal(typeof saved.document.pub, "string");
      let head = await current(harness.db, saved.id);
      const { result: edited } = await change(
        env,
        edit(saved.id, head.id, {
          ...(head.document as JsonObject),
          content: "y",
        }),
      );
      assert.equal(edited.resources[0]?.document.pub, saved.document.pub);
      // A singleton list is the same publication and updated time.
      head = await current(harness.db, saved.id);
      const listed = head.document as JsonObject;
      await change(
        env,
        edit(saved.id, head.id, {
          ...listed,
          pub: [listed.pub!],
          updated: [listed.updated!],
        }),
      );
      head = await current(harness.db, saved.id);
      await change(
        env,
        edit(saved.id, head.id, {
          ...(head.document as JsonObject),
          content: "z",
        }),
      );
      head = await current(harness.db, saved.id);
      await change(env, remove(saved.id, head.id));
      const whiteout = await current(harness.db, saved.id);
      assert.deepEqual(whiteout.formerTypes, ["Note"]);
    });
  });

  it("keeps a missing publication time missing", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const resource = await ensureResource(
        harness.db,
        `${ACTOR_IRI}/${uuidV7()}`,
      );
      const head = await appendResourceRevision(harness.db, {
        resourceId: resource.id,
        resourceKind: "object",
        expectedRevisionId: null,
        kind: "snapshot",
        capture: "local",
        document: {
          "@context": AS,
          id: resource.iri,
          type: "Note",
          content: "x",
          attributedTo: ACTOR_IRI,
        },
      });
      const added = await previewLocalWrite(
        env,
        PRINCIPAL,
        edit(resource.id, head.id, {
          "@context": AS,
          type: "Note",
          content: "y",
          published: "2026-01-01T00:00:00Z",
        }),
      );
      assert.ok(!added.ok);
      assert.deepEqual(
        added.error.diagnostics.map(({ reason, path }) => [reason, path]),
        [["server_owned_field_conflict", ["published"]]],
      );
      const { result } = await change(
        env,
        edit(resource.id, head.id, {
          "@context": AS,
          type: "Note",
          content: "y",
          published: null,
        }),
      );
      // Null is absence, as the validator reads it.
      assert.equal(result.resources[0]?.document.published ?? null, null);
    });
  });

  it("edits a legacy typed Note in step with the columns it is served from", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const legacy = await seedLegacyNote(harness);
      const loaded = legacy.head.document as JsonObject;
      const { preview, result } = await change(
        env,
        edit(legacy.id, legacy.head.id, {
          ...loaded,
          content: "<p>Second</p>",
          contentMap: { en: "<p>Second</p>" },
        }),
      );
      assert.ok(
        preview.changes.some(
          ({ reason }) => reason === "replace_legacy_context",
        ),
      );
      const [version] = result.resources;
      assert.deepEqual(version?.document["@context"], [
        AS,
        { sensitive: "as:sensitive" },
      ]);
      const row = await harness.db.query.objects.findFirst({
        where: { id: legacy.id },
      });
      assert.equal(row?.contentHtml, "<p>Second</p>");
      assert.equal(row?.language, "en");
      assert.equal(row?.updated.toString(), version?.document.updated);
      const response = await harness.federation.fetch(
        new Request(legacy.iri, {
          headers: { accept: "application/activity+json" },
        }),
        { contextData: undefined },
      );
      assert.equal(response.status, 200);
      assert.equal((await response.json()).content, "<p>Second</p>");
      // The legacy Create and its revision are untouched.
      const createHead = await current(harness.db, legacy.activityId as Uuid);
      assert.equal(createHead.sequence, 1);

      const head = await current(harness.db, legacy.id);
      for (const content of ["   ", "<p>Third</p>"]) {
        const document = { ...(head.document as JsonObject), content };
        if (content.trim() === "") {
          const blank = await previewLocalWrite(
            env,
            PRINCIPAL,
            edit(legacy.id, head.id, document),
          );
          assert.ok(!blank.ok);
          assert.equal(blank.error.type, "unsupported_edit");
        }
      }
      // A served column changed outside the history is drift.
      await harness.db
        .update(schema.objects)
        .set({ contentHtml: "<p>Drifted</p>" })
        .where(eq(schema.objects.id, legacy.id));
      const drifted = await previewLocalWrite(
        env,
        PRINCIPAL,
        edit(legacy.id, head.id, {
          ...(head.document as JsonObject),
          contentMap: null,
          content: "<p>Third</p>",
        }),
      );
      assert.ok(!drifted.ok);
      assert.equal(drifted.error.type, "unsupported_edit");
    });
  });

  it("deletes objects with a whiteout and a Delete addressed as they were", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const context = [AS, { hidden: { "@id": "as:bcc", "@type": "@id" } }];
      const { result: initial } = await save(
        env,
        create({
          "@context": context,
          type: "Note",
          content: "x",
          to: [PUBLIC_IRI],
          hidden: [
            "https://remote.example/users/blind",
            "https://remote.example/users/blind",
          ],
        }),
      );
      const saved = initial.resources[0]!;
      const head = await current(harness.db, saved.id);
      const before = await counts(harness.db);
      await assert.rejects(
        change(env, remove(saved.id, head.id), () =>
          Promise.reject(new Error("queue down")),
        ),
        /queue down/u,
      );
      assert.deepEqual(await counts(harness.db), before);
      const { result } = await change(env, remove(saved.id, head.id));
      const [deletion] = result.resources;
      assert.deepEqual(deletion?.document["@context"], context);
      assert.equal(deletion?.document.type, "Delete");
      assert.equal(deletion?.document.object, saved.iri);
      assert.deepEqual(deletion?.document.to, [PUBLIC_IRI]);
      assert.deepEqual(deletion?.document.hidden, [
        "https://remote.example/users/blind",
        "https://remote.example/users/blind",
      ]);
      const whiteout = await current(harness.db, saved.id);
      assert.equal(whiteout.kind, "whiteout");
      assert.equal(whiteout.id, result.whiteoutRevisionId);
      assert.deepEqual(whiteout.formerTypes, ["Note"]);
      // The last content's recipients still describe the deleted object.
      assert.equal(
        await harness.db.$count(
          schema.addressing,
          eq(schema.addressing.sourceId, saved.id),
        ),
        3,
      );
      const again = await previewLocalWrite(
        env,
        PRINCIPAL,
        remove(saved.id, whiteout.id),
      );
      assert.ok(!again.ok);
      assert.equal(again.error.type, "unsupported_edit");
    });
  });

  it("deletes a legacy typed Note, which is then served as a Tombstone", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const legacy = await seedLegacyNote(harness);
      const { result } = await change(env, remove(legacy.id, legacy.head.id));
      const [deletion] = result.resources;
      assert.equal(deletion?.document["@context"], AS);
      assert.deepEqual(deletion?.document.to, [PUBLIC_IRI]);
      assert.deepEqual(deletion?.document.bcc, [
        "https://remote.example/users/blind",
      ]);
      const row = await harness.db.query.objects.findFirst({
        where: { id: legacy.id },
      });
      assert.notEqual(row?.deleted, null);
      const response = await harness.federation.fetch(
        new Request(legacy.iri, {
          headers: { accept: "application/activity+json" },
        }),
        { contextData: undefined },
      );
      assert.equal(response.status, 410);
    });
  });
});
