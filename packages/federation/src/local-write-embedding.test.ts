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
  type EmbeddedSource,
  type JsonObject,
  type LocalWriteEnvironment,
  type LocalWriteRequest,
  commitLocalWrite,
  previewLocalWrite,
} from "@drfed/federation/local-write";
import { type Database, schema } from "@drfed/models";
import { PUBLIC_IRI } from "@drfed/models/resource";
import { loadCurrentResourceRevision } from "@drfed/models/resource-revision";
import type { Uuid } from "@drfed/models/uuid";
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
const ROOT_ORIGIN = new URL("https://drfed.org");
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000301" as Uuid;
const PRINCIPAL = { accountId: ACCOUNT_ID };
const MISSING_REVISION_ID = "00000000-0000-4000-8000-000000000999" as Uuid;
const NOTE = {
  "@context": AS,
  type: "Note",
  content: "<p>Hello</p>",
  to: [PUBLIC_IRI],
};

async function seedMember(db: Database) {
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
    accepted: created,
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

function create(
  document: JsonObject,
  resources: CreateRequest["resources"] = [{ path: [], kind: "object" }],
  sources?: readonly EmbeddedSource[],
): CreateRequest {
  return {
    operation: "create",
    actorId: localActorId,
    document,
    resources,
    ...(sources == null ? {} : { sources }),
  };
}

const activity = (
  document: JsonObject,
  sources?: readonly EmbeddedSource[],
): CreateRequest => create(document, [{ path: [], kind: "activity" }], sources);

const reserve: NonNullable<CommitOptions["reserveDispatch"]> = () =>
  Promise.resolve();

async function write(env: LocalWriteEnvironment, request: LocalWriteRequest) {
  const preview = await previewLocalWrite(env, PRINCIPAL, request);
  assert.ok(preview.ok, JSON.stringify(!preview.ok && preview.error));
  const outcome = await commitLocalWrite(env, PRINCIPAL, request, {
    previewToken: preview.preview.token,
    ...(request.operation === "create" && request.publish !== true
      ? {}
      : { reserveDispatch: reserve }),
  });
  assert.ok(outcome.ok, JSON.stringify(!outcome.ok && outcome.error));
  return outcome.result;
}

async function head(db: Database, id: Uuid) {
  const revision = await loadCurrentResourceRevision(db, id);
  assert.ok(revision != null && revision.document != null);
  return { ...revision, document: revision.document as JsonObject };
}

async function embeddings(db: Database, revisionId: Uuid) {
  const rows = await db
    .select()
    .from(schema.revisionEmbeddings)
    .where(eq(schema.revisionEmbeddings.revisionId, revisionId));
  return rows
    .map(({ path, sourceRevisionId, relation }) => ({
      path,
      sourceRevisionId,
      relation,
    }))
    .toSorted((left, right) =>
      JSON.stringify(left.path).localeCompare(JSON.stringify(right.path)),
    );
}

const withoutContext = ({ "@context": _, ...rest }: JsonObject): JsonObject =>
  rest;

/**
 * Saves a Note and edits it once, so that its first revision is past.
 * @returns The saved Note, its first revision, and its current revision.
 */
async function savedNote(env: LocalWriteEnvironment, db: Database) {
  const [note] = (await write(env, create(NOTE))).resources;
  assert.ok(note != null);
  const first = await head(db, note.id);
  await write(env, {
    operation: "edit",
    actorId: localActorId,
    objectId: note.id,
    expectedRevisionId: first.id,
    document: { ...first.document, content: "<p>Edited</p>" },
  });
  return { note, first, current: await head(db, note.id) };
}

describe("embedded document sources", () => {
  it("records a nested new resource kept embedded as a snapshot", async () => {
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
        const [note, root] = (
          await write(
            env,
            create(document, [
              { path: [], kind: "activity" },
              { path: ["object"], kind: "object", representation },
            ]),
          )
        ).resources;
        assert.ok(note != null && root != null);
        assert.deepEqual(
          await embeddings(harness.db, root.revisionId),
          representation === "embedded"
            ? [
                {
                  path: ["object"],
                  sourceRevisionId: note.revisionId,
                  relation: "snapshot",
                },
              ]
            : [],
        );
        assert.deepEqual(await embeddings(harness.db, note.revisionId), []);
      }
    });
  });

  it("records the Update of an edit as a snapshot of the new version", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const [note] = (await write(env, create(NOTE))).resources;
      assert.ok(note != null);
      const first = await head(harness.db, note.id);
      const [version, update] = (
        await write(env, {
          operation: "edit",
          actorId: localActorId,
          objectId: note.id,
          expectedRevisionId: first.id,
          document: { ...first.document, content: "<p>B</p>" },
        })
      ).resources;
      assert.ok(version != null && update != null);
      assert.deepEqual(await embeddings(harness.db, update.revisionId), [
        {
          path: ["object"],
          sourceRevisionId: version.revisionId,
          relation: "snapshot",
        },
      ]);
      assert.deepEqual(await embeddings(harness.db, version.revisionId), []);
    });
  });

  it("records a declared source as kept or derived by comparing documents", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { first } = await savedNote(env, harness.db);
      for (const [content, relation] of [
        ["<p>Hello</p>", "snapshot"],
        ["<p>Changed</p>", "derived"],
      ] as const) {
        const [like] = (
          await write(
            env,
            activity(
              {
                "@context": AS,
                type: "Like",
                object: { ...withoutContext(first.document), content },
                to: [PUBLIC_IRI],
              },
              [{ path: ["object"], revisionId: first.id }],
            ),
          )
        ).resources;
        assert.ok(like != null);
        assert.deepEqual(await embeddings(harness.db, like.revisionId), [
          { path: ["object"], sourceRevisionId: first.id, relation },
        ]);
      }
    });
  });

  it("records declared sources of an edited version, not of its Update", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { first } = await savedNote(env, harness.db);
      const [other] = (await write(env, create(NOTE))).resources;
      assert.ok(other != null);
      const otherHead = await head(harness.db, other.id);
      const [version, update] = (
        await write(env, {
          operation: "edit",
          actorId: localActorId,
          objectId: other.id,
          expectedRevisionId: otherHead.id,
          document: {
            ...otherHead.document,
            location: withoutContext(first.document),
          },
          sources: [{ path: ["location"], revisionId: first.id }],
        })
      ).resources;
      assert.ok(version != null && update != null);
      assert.deepEqual(await embeddings(harness.db, version.revisionId), [
        {
          path: ["location"],
          sourceRevisionId: first.id,
          relation: "snapshot",
        },
      ]);
      // The past version the Update carries has no current match.
      assert.deepEqual(await embeddings(harness.db, update.revisionId), [
        {
          path: ["object"],
          sourceRevisionId: version.revisionId,
          relation: "snapshot",
        },
      ]);
    });
  });

  it("treats a different context as derived, and an equal one spelled as a list as kept", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { first } = await savedNote(env, harness.db);
      for (const [context, relation] of [
        [[AS], "snapshot"],
        [[AS, { extra: "https://example.com/extra" }], "derived"],
      ] as const) {
        const [like] = (
          await write(
            env,
            activity(
              {
                "@context": context,
                type: "Like",
                object: withoutContext(first.document),
                to: [PUBLIC_IRI],
              },
              [{ path: ["object"], revisionId: first.id }],
            ),
          )
        ).resources;
        assert.ok(like != null);
        assert.deepEqual(await embeddings(harness.db, like.revisionId), [
          { path: ["object"], sourceRevisionId: first.id, relation },
        ]);
      }
    });
  });

  it("matches an undeclared document only to the current snapshot it keeps", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { first, current } = await savedNote(env, harness.db);
      for (const [object, expected] of [
        [
          withoutContext(current.document),
          [
            {
              path: ["object"],
              sourceRevisionId: current.id,
              relation: "snapshot",
            },
          ],
        ],
        // The past version and a changed copy have no known source.
        [withoutContext(first.document), []],
        [{ ...withoutContext(current.document), content: "<p>X</p>" }, []],
      ] as const) {
        const [like] = (
          await write(
            env,
            activity({
              "@context": AS,
              type: "Like",
              object,
              to: [PUBLIC_IRI],
            }),
          )
        ).resources;
        assert.ok(like != null);
        assert.deepEqual(
          await embeddings(harness.db, like.revisionId),
          expected,
        );
      }
    });
  });

  it("records nothing for a Link, a reference, or a deletion", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { note, current } = await savedNote(env, harness.db);
      for (const object of [{ type: "Link", href: note.iri }, note.iri]) {
        const [like] = (
          await write(
            env,
            activity({
              "@context": AS,
              type: "Like",
              object,
              to: [PUBLIC_IRI],
            }),
          )
        ).resources;
        assert.ok(like != null);
        assert.deepEqual(await embeddings(harness.db, like.revisionId), []);
      }
      const [removal] = (
        await write(env, {
          operation: "delete",
          actorId: localActorId,
          objectId: note.id,
          expectedRevisionId: current.id,
        })
      ).resources;
      assert.ok(removal != null);
      assert.deepEqual(await embeddings(harness.db, removal.revisionId), []);
    });
  });

  it("refuses invalid declarations in the preview", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { note, first } = await savedNote(env, harness.db);
      const [other] = (await write(env, create(NOTE))).resources;
      assert.ok(other != null);
      const otherHead = await head(harness.db, other.id);
      const like = {
        "@context": AS,
        type: "Like",
        object: withoutContext(first.document),
        instrument: { type: "Link", href: note.iri },
        to: [PUBLIC_IRI],
      };
      const cases: [string, LocalWriteRequest][] = [
        ["root", activity(like, [{ path: [], revisionId: first.id }])],
        [
          "not a document",
          activity(like, [{ path: ["to", 0], revisionId: first.id }]),
        ],
        [
          "Link",
          activity(like, [{ path: ["instrument"], revisionId: first.id }]),
        ],
        [
          "twice",
          activity(like, [
            { path: ["object"], revisionId: first.id },
            { path: ["object"], revisionId: first.id },
          ]),
        ],
        [
          "another resource's revision",
          activity(like, [{ path: ["object"], revisionId: otherHead.id }]),
        ],
        [
          "missing revision",
          activity(like, [
            { path: ["object"], revisionId: MISSING_REVISION_ID },
          ]),
        ],
        [
          "no id",
          activity(
            {
              ...like,
              object: { type: "Note", content: "<p>Anonymous</p>" },
            },
            [{ path: ["object"], revisionId: first.id }],
          ),
        ],
        [
          "new resource",
          create(
            {
              "@context": AS,
              type: "Create",
              to: [PUBLIC_IRI],
              object: { type: "Note", content: "<p>New</p>" },
            },
            [
              { path: [], kind: "activity" },
              { path: ["object"], kind: "object" },
            ],
            [{ path: ["object"], revisionId: first.id }],
          ),
        ],
        [
          "malformed",
          {
            ...activity(like),
            sources: "object" as unknown as EmbeddedSource[],
          },
        ],
        [
          "malformed in an edit",
          {
            operation: "edit",
            actorId: localActorId,
            objectId: other.id,
            expectedRevisionId: otherHead.id,
            document: otherHead.document,
            sources: [{ path: ["object"], revisionId: "nope" as Uuid }],
          },
        ],
      ];
      for (const [label, request] of cases) {
        const preview = await previewLocalWrite(env, PRINCIPAL, request);
        assert.ok(!preview.ok, label);
        assert.equal(preview.error.type, "invalid_request", label);
      }
    });
  });

  it("binds declared sources to the preview token", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { first, current } = await savedNote(env, harness.db);
      const like = {
        "@context": AS,
        type: "Like",
        object: withoutContext(first.document),
        to: [PUBLIC_IRI],
      };
      const preview = await previewLocalWrite(
        env,
        PRINCIPAL,
        activity(like, [{ path: ["object"], revisionId: first.id }]),
      );
      assert.ok(preview.ok);
      for (const sources of [
        undefined,
        [{ path: ["object"], revisionId: current.id }],
      ]) {
        const outcome = await commitLocalWrite(
          env,
          PRINCIPAL,
          activity(like, sources),
          { previewToken: preview.preview.token },
        );
        assert.ok(!outcome.ok);
        assert.equal(outcome.error.type, "stale_preview");
      }
      assert.equal(await harness.db.$count(schema.revisionEmbeddings), 1);
    });
  });
});
