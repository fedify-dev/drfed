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
  type CreateRequest,
  type LocalWriteEnvironment,
  type SavedResource,
  commitLocalWrite,
  previewLocalWrite,
} from "@drfed/federation/local-write";
import { type Database, schema } from "@drfed/models";
import { PUBLIC_IRI } from "@drfed/models/resource";
import {
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
} from "./seed.test.ts";

const AS = "https://www.w3.org/ns/activitystreams";
const rootOrigin = new URL("https://drfed.org");
const accountId = "00000000-0000-4000-8000-000000000301" as Uuid;
const principal = { accountId };
const actorIri = `https://test-instance.drfed.org/users/${localActorId}`;

async function seedMember(db: Database, accepted: boolean = true) {
  await seedLocalActor(db, { keys: false });
  await db.insert(schema.accounts).values({
    id: accountId,
    email: "member@example.com",
    name: "Member",
    created,
  });
  await db.insert(schema.instanceMembers).values({
    accountId,
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
    rootOrigin,
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
  const preview = await previewLocalWrite(env, principal, request);
  assert.ok(preview.ok, JSON.stringify(!preview.ok && preview.error));
  const outcome = await commitLocalWrite(env, principal, request, {
    previewToken: preview.preview.token,
    ...(reserveDispatch == null
      ? {}
      : { reserveDispatch: (_tx, activity) => reserveDispatch(activity) }),
  });
  assert.ok(outcome.ok, JSON.stringify(!outcome.ok && outcome.error));
  return { preview: preview.preview, result: outcome.result };
}

const note = {
  "@context": AS,
  type: "Note",
  content: "<p>Hello</p>",
  to: [PUBLIC_IRI],
  bcc: ["https://remote.example/users/blind"],
};

describe("previewLocalWrite() and commitLocalWrite()", () => {
  it("saves an object alone, without an activity, outbox entry, or delivery", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const before = await counts(harness.db);
      const preview = await previewLocalWrite(env, principal, create(note));
      assert.ok(preview.ok);
      assert.deepEqual(await counts(harness.db), before);
      const [prepared] = preview.preview.resources;
      assert.ok(prepared != null);
      assert.match(
        prepared.iri,
        new RegExp(`^${actorIri}/[0-9a-f-]{36}$`, "u"),
      );
      assert.equal(prepared.document.id, prepared.iri);
      assert.equal(prepared.document.attributedTo, actorIri);
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
      const outcome = await commitLocalWrite(env, principal, create(note), {
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
      // Revision-only until generalized reads arrive; nothing else changed.
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
          new RegExp(`^${actorIri}/`, "u"),
        );
      }
    });
  });

  it("saves an activity referring to an existing object and an external IRI without touching them", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { result: first } = await save(env, create(note));
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
      assert.equal(saved.document.actor, actorIri);
      assert.equal(saved.document.object, noteResource.iri);
      assert.deepEqual(
        saved.relations.map(({ property, representation, targetIri }) => [
          property,
          representation,
          targetIri,
        ]),
        [
          ["actor", "reference", actorIri],
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
        assert.equal(nested.document.attributedTo, actorIri);
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
      assert.equal(like?.document.actor, actorIri);
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
        principal,
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
      await seedMember(harness.db);
      const env = await environment(harness);
      const other = "https://other.drfed.org/users/victim";
      for (const [document, path] of [
        [
          {
            "@context": AS,
            type: "Undo",
            object: {
              type: "Like",
              actor: other,
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
          principal,
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
            attributedTo: other,
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
              attributedTo: other,
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
          { "@context": AS, type: "Question", name: "q", actor: other },
          [{ path: [], kind: "object" }],
          ["actor"],
        ],
      ] as const) {
        const outcome = await previewLocalWrite(
          env,
          principal,
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
      for (const actor of [actorIri, "https://remote.example/users/bob"]) {
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
        principal,
        create({ ...note, attributedTo: "https://remote.example/users/bob" }),
      );
      assert.ok(!conflict.ok);
      assert.ok(
        conflict.error.diagnostics.some(
          ({ reason }) => reason === "server_owned_field_conflict",
        ),
      );
    });
  });

  it("checks membership on every preview and commit", async () => {
    for (const scenario of ["pending", "missing", "expired", "deleted"]) {
      await withFederation(async (harness) => {
        await seedMember(harness.db, scenario !== "pending");
        const env = await environment(harness);
        const preview = await previewLocalWrite(env, principal, create(note));
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
        const outcome = await commitLocalWrite(env, principal, create(note), {
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
      const request = create(note);
      const preview = await previewLocalWrite(env, principal, request);
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
        [token, create({ ...note, content: "changed" }), "stale_preview"],
      ] as const) {
        const outcome = await commitLocalWrite(env, principal, changed, {
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
      const first = await commitLocalWrite(env, principal, request, {
        previewToken: token,
      });
      assert.ok(first.ok);
      assert.deepEqual(
        first.result.resources[0]?.document,
        preview.preview.resources[0]?.document,
      );
      const before = await counts(harness.db);
      const replay = await commitLocalWrite(env, principal, request, {
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
      const preview = await previewLocalWrite(env, principal, request);
      assert.ok(preview.ok);
      const { token: previewToken } = preview.preview;
      const missing = await commitLocalWrite(env, principal, request, {
        previewToken,
      });
      assert.ok(!missing.ok);
      assert.equal(missing.error.type, "invalid_request");
      const before = await counts(harness.db);
      await assert.rejects(
        commitLocalWrite(env, principal, request, {
          previewToken,
          reserveDispatch: () => Promise.reject(new Error("queue down")),
        }),
        /queue down/u,
      );
      assert.deepEqual(await counts(harness.db), before);
      const reserved: SavedResource[] = [];
      const retried = await commitLocalWrite(env, principal, request, {
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
      // Saved without a legacy typed row, it is not served yet.
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
          principal,
          create(document, resources as never, extra as never),
        );
        assert.ok(!outcome.ok, JSON.stringify(resources));
        assert.equal(outcome.error.type, "invalid_request");
      }
      const publishedObject = await previewLocalWrite(
        env,
        principal,
        create(note, [{ path: [], kind: "object" }], { publish: true }),
      );
      assert.ok(!publishedObject.ok);
      assert.equal(publishedObject.error.type, "invalid_request");
    });
  });
});
