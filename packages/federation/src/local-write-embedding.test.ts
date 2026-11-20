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
  type PreviewOptions,
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

/** Lets the principal read every revision. */
const READ_ALL: PreviewOptions = {
  unreadableRevisions: () => Promise.resolve(new Set()),
};

/**
 * Lets the principal read every revision but the given ones.
 * @returns The options that check declared sources so.
 */
const readAllBut = (...hidden: Uuid[]): PreviewOptions => ({
  unreadableRevisions: (ids) =>
    Promise.resolve(new Set(ids.filter((id) => hidden.includes(id)))),
});

async function write(env: LocalWriteEnvironment, request: LocalWriteRequest) {
  const preview = await previewLocalWrite(env, PRINCIPAL, request, READ_ALL);
  assert.ok(preview.ok, JSON.stringify(!preview.ok && preview.error));
  const outcome = await commitLocalWrite(env, PRINCIPAL, request, {
    ...READ_ALL,
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

function byPath<T extends { readonly path: readonly (string | number)[] }>(
  rows: readonly T[],
): T[] {
  return rows.toSorted((left, right) =>
    JSON.stringify(left.path).localeCompare(JSON.stringify(right.path)),
  );
}

async function embeddings(db: Database, revisionId: Uuid) {
  const rows = await db
    .select()
    .from(schema.revisionEmbeddings)
    .where(eq(schema.revisionEmbeddings.revisionId, revisionId));
  return byPath(
    rows.map(({ path, sourceRevisionId, relation }) => ({
      path,
      sourceRevisionId,
      relation,
    })),
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

  it("records declared sources of an edited version, and in its Update", async () => {
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
      // The Update keeps the version, so it records the version's sources
      // at its own paths.
      assert.deepEqual(await embeddings(harness.db, update.revisionId), [
        {
          path: ["object", "location"],
          sourceRevisionId: first.id,
          relation: "snapshot",
        },
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

  it("records the sources of nested documents at every depth", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { first } = await savedNote(env, harness.db);
      const [note, root] = (
        await write(
          env,
          create(
            {
              "@context": AS,
              type: "Create",
              to: [PUBLIC_IRI],
              object: {
                type: "Note",
                content: "<p>Nested</p>",
                to: [PUBLIC_IRI],
                location: withoutContext(first.document),
              },
            },
            [
              { path: [], kind: "activity" },
              { path: ["object"], kind: "object", representation: "embedded" },
            ],
            [{ path: ["object", "location"], revisionId: first.id }],
          ),
        )
      ).resources;
      assert.ok(note != null && root != null);
      assert.deepEqual(await embeddings(harness.db, note.revisionId), [
        {
          path: ["location"],
          sourceRevisionId: first.id,
          relation: "snapshot",
        },
      ]);
      assert.deepEqual(await embeddings(harness.db, root.revisionId), [
        {
          path: ["object", "location"],
          sourceRevisionId: first.id,
          relation: "snapshot",
        },
        {
          path: ["object"],
          sourceRevisionId: note.revisionId,
          relation: "snapshot",
        },
      ]);
    });
  });

  it("never guesses the source of an undeclared document", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { first, current } = await savedNote(env, harness.db);
      // Not even a copy of the current snapshot, which a pasted document
      // may equal by chance.
      for (const object of [
        withoutContext(current.document),
        withoutContext(first.document),
        { ...withoutContext(current.document), content: "<p>X</p>" },
      ]) {
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
    });
  });

  it("never takes an older copy inside an edited object for the new version", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { note, first, current } = await savedNote(env, harness.db);
      const [version, update] = (
        await write(env, {
          operation: "edit",
          actorId: localActorId,
          objectId: note.id,
          expectedRevisionId: current.id,
          document: {
            ...current.document,
            location: withoutContext(first.document),
          },
        })
      ).resources;
      assert.ok(version != null && update != null);
      assert.deepEqual(await embeddings(harness.db, version.revisionId), []);
      // The copy shares the object's IRI, but it is not the version the
      // write saved under that IRI, and its source stays unknown here too.
      assert.deepEqual(await embeddings(harness.db, update.revisionId), [
        {
          path: ["object"],
          sourceRevisionId: version.revisionId,
          relation: "snapshot",
        },
      ]);
    });
  });

  it("keeps the sources of the addressing an Update or a Delete copies", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { note, current } = await savedNote(env, harness.db);
      const [recipient, place] = [
        (await write(env, create(NOTE))).resources[0],
        (await write(env, create(NOTE))).resources[0],
      ];
      assert.ok(recipient != null && place != null);
      const source = await head(harness.db, recipient.id);
      const located = await head(harness.db, place.id);
      const [version, update] = (
        await write(env, {
          operation: "edit",
          actorId: localActorId,
          objectId: note.id,
          expectedRevisionId: current.id,
          document: {
            ...current.document,
            to: [
              {
                ...withoutContext(source.document),
                location: withoutContext(located.document),
              },
            ],
          },
          sources: [
            { path: ["to", 0], revisionId: source.id },
            { path: ["to", 0, "location"], revisionId: located.id },
          ],
        })
      ).resources;
      assert.ok(version != null && update != null);
      const recipientRows = [
        { path: ["to", 0], sourceRevisionId: source.id, relation: "derived" },
        {
          path: ["to", 0, "location"],
          sourceRevisionId: located.id,
          relation: "snapshot",
        },
      ];
      assert.deepEqual(
        await embeddings(harness.db, version.revisionId),
        byPath(recipientRows),
      );
      // The Update carries the version under object and copies its
      // addressing to its root; both copies keep the version's sources.
      assert.deepEqual(
        await embeddings(harness.db, update.revisionId),
        byPath([
          {
            path: ["object"],
            sourceRevisionId: version.revisionId,
            relation: "snapshot",
          },
          ...recipientRows.map((row) => ({
            ...row,
            path: ["object", ...row.path],
          })),
          ...recipientRows,
        ]),
      );
      const [removal] = (
        await write(env, {
          operation: "delete",
          actorId: localActorId,
          objectId: note.id,
          expectedRevisionId: version.revisionId,
        })
      ).resources;
      assert.ok(removal != null);
      // The Delete names the object by IRI and copies the addressing of
      // its last version, with that version's sources.
      assert.deepEqual(
        await embeddings(harness.db, removal.revisionId),
        byPath(recipientRows),
      );
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
      const { note, first, current } = await savedNote(env, harness.db);
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
        [
          // The saved version would drop the declaration, and the Update
          // would name the new version as the source of the old copy.
          "the edited object itself",
          {
            operation: "edit",
            actorId: localActorId,
            objectId: note.id,
            expectedRevisionId: current.id,
            document: {
              ...current.document,
              location: withoutContext(first.document),
            },
            sources: [{ path: ["location"], revisionId: first.id }],
          },
        ],
      ];
      for (const [label, request] of cases) {
        const preview = await previewLocalWrite(
          env,
          PRINCIPAL,
          request,
          READ_ALL,
        );
        assert.ok(!preview.ok, label);
        assert.equal(preview.error.type, "invalid_request", label);
      }
      // Declaring sources needs a check of what the principal may read.
      const declared = activity(like, [
        { path: ["object"], revisionId: first.id },
      ]);
      const unchecked = await previewLocalWrite(env, PRINCIPAL, declared);
      assert.ok(!unchecked.ok);
      assert.equal(unchecked.error.type, "invalid_request");
    });
  });

  it("refuses unavailable sources alike, whatever makes them so", async () => {
    await withFederation(async (harness) => {
      await seedMember(harness.db);
      const env = await environment(harness);
      const { first } = await savedNote(env, harness.db);
      const [other] = (await write(env, create(NOTE))).resources;
      assert.ok(other != null);
      const otherHead = await head(harness.db, other.id);
      await write(env, {
        operation: "delete",
        actorId: localActorId,
        objectId: other.id,
        expectedRevisionId: otherHead.id,
      });
      const whiteout = await loadCurrentResourceRevision(harness.db, other.id);
      assert.ok(whiteout?.kind === "whiteout");
      const like = (revisionId: Uuid) =>
        activity(
          {
            "@context": AS,
            type: "Like",
            object: withoutContext(first.document),
            to: [PUBLIC_IRI],
          },
          [{ path: ["object"], revisionId }],
        );
      const cases: [string, Uuid, PreviewOptions][] = [
        ["missing", MISSING_REVISION_ID, READ_ALL],
        ["unreadable", first.id, readAllBut(first.id)],
        ["another resource's", otherHead.id, READ_ALL],
        ["a whiteout", whiteout.id, READ_ALL],
      ];
      const errors = [];
      for (const [label, revisionId, options] of cases) {
        const preview = await previewLocalWrite(
          env,
          PRINCIPAL,
          like(revisionId),
          options,
        );
        assert.ok(!preview.ok, label);
        errors.push(preview.error);
      }
      // Nothing tells a revision the principal may not read from one that
      // does not exist.
      for (const error of errors) {
        assert.deepEqual(error, {
          type: "source_unavailable",
          message: errors[0]!.message,
          diagnostics: [
            {
              reason: "source_unavailable",
              category: "authority",
              severity: "error",
              path: ["object"],
              message: errors[0]!.diagnostics[0]!.message,
            },
          ],
        });
      }
      // The commit checks again, since access may change after the preview.
      const preview = await previewLocalWrite(
        env,
        PRINCIPAL,
        like(first.id),
        READ_ALL,
      );
      assert.ok(preview.ok);
      const before = await harness.db.$count(schema.resourceRevisions);
      const outcome = await commitLocalWrite(env, PRINCIPAL, like(first.id), {
        ...readAllBut(first.id),
        previewToken: preview.preview.token,
      });
      assert.ok(!outcome.ok);
      assert.deepEqual(outcome.error, errors[0]);
      assert.equal(await harness.db.$count(schema.resourceRevisions), before);
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
        READ_ALL,
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
          { ...READ_ALL, previewToken: preview.preview.token },
        );
        assert.ok(!outcome.ok);
        assert.equal(outcome.error.type, "stale_preview");
      }
      assert.equal(await harness.db.$count(schema.revisionEmbeddings), 1);
    });
  });
});
