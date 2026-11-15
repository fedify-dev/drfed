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

// Writes and pages depend on the ones before them.
// oxlint-disable no-await-in-loop
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type CreateRequest,
  type JsonObject,
  type LocalWriteEnvironment,
  type LocalWriteRequest,
  commitLocalWrite,
  previewLocalWrite,
} from "@drfed/federation/local-write";
import { type Database, schema } from "@drfed/models";
import { PUBLIC_IRI, ensureResource } from "@drfed/models/resource";
import {
  appendResourceRevision,
  captureLegacyResourceRevision,
  loadCurrentResourceRevision,
  writeTypedResourceRevision,
} from "@drfed/models/resource-revision";
import type { Account } from "@drfed/models/schema";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";
import { eq } from "drizzle-orm";

import { hashSecret } from "./auth/hash.ts";
import { type TestHarness, withTestHarness } from "./harness.test.ts";
import {
  accountId,
  created,
  expires,
  globalId,
  localActorId,
  localInstanceId,
  remoteActorId,
  seedAuthenticatedLocalInstance,
  seedLocalActor,
  seedObjects,
  seedRemoteActor,
} from "./seed.test.ts";

const AS = "https://www.w3.org/ns/activitystreams";
const ACTOR_IRI = `https://test-instance.drfed.org/users/${localActorId}`;
const FEATURED_IRI = `${ACTOR_IRI}/featured`;
const BLIND = "https://remote.example/users/blind";
const PRINCIPAL = { accountId: accountId as Uuid };
const CAROL = "https://remote.example/users/carol";

const revisionId = (id: string): string =>
  Buffer.from(`ResourceRevision:${id}`).toString("base64");

interface Writer {
  readonly harness: TestHarness;
  readonly auth: RequestInit;
  /** Saves new resources and returns their IDs and IRIs, root last. */
  save(
    document: JsonObject,
    resources?: CreateRequest["resources"],
  ): Promise<{ id: Uuid; iri: string }[]>;
  /** Commits an edit or deletion. */
  change(request: LocalWriteRequest): Promise<void>;
  /** Sends a query, anonymously unless `init` authenticates it. */
  query(
    query: string,
    variables?: Record<string, unknown>,
    init?: RequestInit,
  ): Promise<{ data?: Record<string, any>; errors?: unknown[] }>;
}

async function withWriter(
  // oxlint-disable-next-line promise/prefer-await-to-callbacks
  callback: (writer: Writer) => Promise<void>,
): Promise<void> {
  await withTestHarness(async (harness) => {
    const auth = await seedAuthenticatedLocalInstance(harness.db);
    await seedLocalActor(harness.db);
    const env: LocalWriteEnvironment = {
      db: harness.db,
      federation: harness.federation,
      rootOrigin: new URL("https://drfed.org"),
      previewKey: await crypto.subtle.generateKey(
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    };
    const commit = async (request: LocalWriteRequest) => {
      const preview = await previewLocalWrite(env, PRINCIPAL, request);
      assert.ok(preview.ok, JSON.stringify(!preview.ok && preview.error));
      const outcome = await commitLocalWrite(env, PRINCIPAL, request, {
        previewToken: preview.preview.token,
        // Edits and deletions require a reservation; nothing is sent here.
        ...(request.operation === "create"
          ? {}
          : { reserveDispatch: () => Promise.resolve() }),
      });
      assert.ok(outcome.ok, JSON.stringify(!outcome.ok && outcome.error));
      return outcome.result;
    };
    // oxlint-disable-next-line promise/prefer-await-to-callbacks, node/callback-return
    await callback({
      harness,
      auth,
      async save(document, resources = [{ path: [], kind: "object" }]) {
        const result = await commit({
          operation: "create",
          actorId: localActorId,
          document: { "@context": AS, ...document },
          resources,
        });
        return result.resources.map(({ id, iri }) => ({ id, iri }));
      },
      async change(request) {
        await commit(request);
      },
      async query(query, variables, init) {
        const response = await harness.post(
          { query, variables: variables ?? {} },
          init,
        );
        return await response.json();
      },
    });
  });
}

async function head(db: Database, id: Uuid) {
  const revision = await loadCurrentResourceRevision(db, id);
  assert.ok(revision != null);
  return revision;
}

const edit = (
  objectId: Uuid,
  expectedRevisionId: Uuid,
  document: JsonObject,
): LocalWriteRequest => ({
  operation: "edit",
  actorId: localActorId,
  objectId,
  expectedRevisionId,
  document,
});

const currentRoot = (selection: string): string =>
  `query($id: ID!) { node(id: $id) { ... on Resource { currentRevision { root { ${selection} } } } } }`;

describe("Resource.currentRevision", () => {
  it("reads relations of embedded documents, as the Like in an Undo", async () => {
    await withWriter(async ({ save, query }) => {
      const [note] = await save({ type: "Note", content: "liked" });
      assert.ok(note != null);
      const [undo] = await save(
        {
          type: "Undo",
          object: { type: "Like", actor: ACTOR_IRI, object: note.iri },
        },
        [{ path: [], kind: "activity" }],
      );
      assert.ok(undo != null);
      const body = await query(
        currentRoot(`
          type kind iri
          relations(property: object) {
            property path representation iri resource { iri }
            node {
              path property type kind iri
              relations(property: object) {
                path representation iri node { type }
                resource { iri kind currentRevision { root { type } } }
              }
            }
          }`),
        { id: globalId("Resource", undo.id) },
      );
      assert.equal(body.errors, undefined);
      assert.deepEqual(body.data?.node.currentRevision.root, {
        type: `${AS}#Undo`,
        kind: "activity",
        iri: undo.iri,
        relations: [
          {
            property: "object",
            path: ["object"],
            representation: "embedded",
            iri: null,
            resource: null,
            node: {
              path: ["object"],
              property: "object",
              type: `${AS}#Like`,
              kind: "activity",
              iri: null,
              relations: [
                {
                  path: ["object", "object"],
                  representation: "reference",
                  iri: note.iri,
                  node: null,
                  resource: {
                    iri: note.iri,
                    kind: "object",
                    currentRevision: { root: { type: `${AS}#Note` } },
                  },
                },
              ],
            },
          },
        ],
      });
    });
  });

  it("keeps an embedded version while the resource shows its edited one", async () => {
    await withWriter(async ({ harness, save, change, query }) => {
      const [note, create] = await save(
        {
          type: "Create",
          to: [PUBLIC_IRI],
          object: { type: "Note", content: "A", to: [PUBLIC_IRI] },
        },
        [
          { path: [], kind: "activity" },
          { path: ["object"], kind: "object" },
        ],
      );
      assert.ok(note != null && create != null);
      const saved = await head(harness.db, note.id);
      await change(
        edit(note.id, saved.id, {
          ...(saved.document as JsonObject),
          content: "B",
        }),
      );
      const body = await query(
        currentRoot(`relations(property: object) {
          representation iri
          node { document }
          resource { currentRevision { sequence document } }
        }`),
        { id: globalId("Resource", create.id) },
      );
      assert.equal(body.errors, undefined);
      assert.ok(body.data != null);
      const [relation] = body.data.node.currentRevision.root.relations;
      assert.equal(relation.representation, "embedded");
      assert.equal(relation.iri, note.iri);
      assert.equal(relation.node.document.content, "A");
      assert.equal(relation.resource.currentRevision.sequence, 2);
      assert.equal(relation.resource.currentRevision.document.content, "B");
    });
  });

  it("reads no object of an intransitive activity", async () => {
    await withWriter(async ({ save, query }) => {
      const [arrive] = await save({ type: "Arrive" }, [
        { path: [], kind: "activity" },
      ]);
      assert.ok(arrive != null);
      const body = await query(
        currentRoot(`
          objects: relations(property: object) { iri }
          actors: relations(property: actor) {
            representation iri resource { kind }
          }`),
        { id: globalId("Resource", arrive.id) },
      );
      assert.deepEqual(body, {
        data: {
          node: {
            currentRevision: {
              root: {
                objects: [],
                actors: [
                  {
                    representation: "reference",
                    iri: ACTOR_IRI,
                    resource: { kind: "actor" },
                  },
                ],
              },
            },
          },
        },
      });
    });
  });

  it("reads the collection target of an Add", async () => {
    await withWriter(async ({ save, query }) => {
      const [note] = await save({ type: "Note", content: "featured" });
      assert.ok(note != null);
      const [add] = await save(
        {
          type: "Add",
          object: note.iri,
          target: { type: "OrderedCollection", id: FEATURED_IRI },
        },
        [{ path: [], kind: "activity" }],
      );
      assert.ok(add != null);
      const body = await query(
        currentRoot(`relations(property: target) {
          representation iri node { kind type } resource { kind iri }
        }`),
        { id: globalId("Resource", add.id) },
      );
      assert.deepEqual(body.data?.node.currentRevision.root.relations, [
        {
          representation: "embedded",
          iri: FEATURED_IRI,
          node: { kind: "collection", type: `${AS}#OrderedCollection` },
          resource: { kind: "collection", iri: FEATURED_IRI },
        },
      ]);
    });
  });

  it("tells unregistered IRIs from registered ones of an unknown kind", async () => {
    await withWriter(async ({ harness, save, query }) => {
      const unregistered = "https://remote.example/unregistered";
      const unknown = "https://remote.example/unknown";
      await ensureResource(harness.db, unknown);
      const [undo] = await save(
        {
          type: "Undo",
          object: [
            { type: "Like", object: unregistered },
            { type: "Like", object: unknown },
          ],
        },
        [{ path: [], kind: "activity" }],
      );
      assert.ok(undo != null);
      const body = await query(
        currentRoot(`relations(property: object) {
          path node { relations { iri resource { iri kind } } }
        }`),
        { id: globalId("Resource", undo.id) },
      );
      assert.deepEqual(body.data?.node.currentRevision.root.relations, [
        {
          path: ["object", 0],
          node: { relations: [{ iri: unregistered, resource: null }] },
        },
        {
          path: ["object", 1],
          node: {
            relations: [
              { iri: unknown, resource: { iri: unknown, kind: "unknown" } },
            ],
          },
        },
      ]);
    });
  });

  it("returns a document with a context outside the offline allowlist uninterpreted", async () => {
    await withWriter(async ({ harness, query }) => {
      const resource = await ensureResource(
        harness.db,
        `${ACTOR_IRI}/${uuidV7()}`,
      );
      const document = {
        "@context": [AS, "https://context.example/ns"],
        id: resource.iri,
        type: "Note",
        content: "contextual",
      };
      await appendResourceRevision(harness.db, {
        resourceId: resource.id,
        resourceKind: "object",
        expectedRevisionId: null,
        kind: "snapshot",
        capture: "local",
        document,
      });
      const body = await query(
        `query($id: ID!) { node(id: $id) { ... on Resource { currentRevision {
          kind capture interpreted root { type } document
          diagnostics { reason category severity path }
        } } } }`,
        { id: globalId("Resource", resource.id) },
      );
      assert.deepEqual(body, {
        data: {
          node: {
            currentRevision: {
              kind: "snapshot",
              capture: "local",
              interpreted: false,
              root: null,
              document,
              diagnostics: [
                {
                  reason: "context_unavailable_offline",
                  category: "support",
                  severity: "error",
                  path: ["@context", 1],
                },
              ],
            },
          },
        },
      });
    });
  });

  it("returns a document with an unsupported property uninterpreted", async () => {
    await withWriter(async ({ harness, query }) => {
      const resource = await ensureResource(
        harness.db,
        `${ACTOR_IRI}/${uuidV7()}`,
      );
      const document = {
        "@context": AS,
        id: resource.iri,
        type: "Note",
        content: "tagged",
        tag: [{ type: "Mention", href: ACTOR_IRI }],
      };
      await appendResourceRevision(harness.db, {
        resourceId: resource.id,
        resourceKind: "object",
        expectedRevisionId: null,
        kind: "snapshot",
        capture: "local",
        document,
      });
      const body = await query(
        `query($id: ID!) { node(id: $id) { ... on Resource { currentRevision {
          interpreted root { type } document diagnostics { reason category severity path }
        } } } }`,
        { id: globalId("Resource", resource.id) },
      );
      assert.deepEqual(body, {
        data: {
          node: {
            currentRevision: {
              interpreted: false,
              root: null,
              document,
              diagnostics: [
                {
                  reason: "unsupported_property",
                  category: "support",
                  severity: "error",
                  path: ["tag"],
                },
              ],
            },
          },
        },
      });
    });
  });

  it("shows anyone the blind recipients of a local resource", async () => {
    await withWriter(async ({ save, query }) => {
      const [note] = await save({
        type: "Note",
        content: "secret",
        to: [PUBLIC_IRI],
        bto: [BLIND],
        bcc: [{ type: "Person", id: BLIND }, BLIND],
      });
      assert.ok(note != null);
      const body = await query(
        `query($id: ID!) { node(id: $id) { ... on Resource { currentRevision {
          document
          root {
            addressing { property position path representation iri }
            bcc: addressing(property: bcc) { iri resource { kind } }
          }
        } } } }`,
        { id: globalId("Resource", note.id) },
      );
      assert.equal(body.errors, undefined);
      const revision = body.data?.node.currentRevision;
      assert.deepEqual(revision.document.bto, [BLIND]);
      assert.deepEqual(revision.document.bcc, [
        { type: "Person", id: BLIND },
        BLIND,
      ]);
      assert.deepEqual(revision.root.addressing, [
        {
          property: "to",
          position: 0,
          path: ["to", 0],
          representation: "reference",
          iri: PUBLIC_IRI,
        },
        {
          property: "bto",
          position: 0,
          path: ["bto", 0],
          representation: "reference",
          iri: BLIND,
        },
        {
          property: "bcc",
          position: 0,
          path: ["bcc", 0],
          representation: "embedded",
          iri: BLIND,
        },
        {
          property: "bcc",
          position: 1,
          path: ["bcc", 1],
          representation: "reference",
          iri: BLIND,
        },
      ]);
      assert.deepEqual(revision.root.bcc, [
        { iri: BLIND, resource: { kind: "unknown" } },
        { iri: BLIND, resource: { kind: "unknown" } },
      ]);
    });
  });

  it("returns custom extension properties by their source keys", async () => {
    await withWriter(async ({ save, query }) => {
      const [note] = await save({
        "@context": [AS, { ex: "https://ext.example/ns#" }],
        type: "Note",
        content: "extended",
        "ex:mood": { level: 3 },
      });
      assert.ok(note != null);
      const body = await query(currentRoot("extensions { key value }"), {
        id: globalId("Resource", note.id),
      });
      assert.deepEqual(body.data?.node.currentRevision.root.extensions, [
        { key: "ex:mood", value: { level: 3 } },
      ]);
    });
  });
});

describe("Resource.revisions", () => {
  it("pages revisions newest first and rejects an invalid cursor", async () => {
    await withWriter(async ({ harness, save, change, query }) => {
      const [note] = await save({ type: "Note", content: "1" });
      assert.ok(note != null);
      for (const content of ["2", "3"]) {
        const current = await head(harness.db, note.id);
        await change(
          edit(note.id, current.id, {
            ...(current.document as JsonObject),
            content,
          }),
        );
      }
      const page = `query($id: ID!, $first: Int, $after: String, $last: Int, $before: String) {
        node(id: $id) { ... on Resource {
          revisions(first: $first, after: $after, last: $last, before: $before) {
            edges { cursor node { sequence document } }
            pageInfo { hasNextPage hasPreviousPage }
          }
        } }
      }`;
      const id = globalId("Resource", note.id);
      const seen: [number, string][] = [];
      let after: string | undefined;
      for (let index = 0; index < 5; index += 1) {
        const body = await query(page, { id, first: 1, after });
        assert.equal(body.errors, undefined);
        assert.ok(body.data != null);
        const { edges, pageInfo } = body.data.node.revisions;
        assert.equal(edges.length, 1);
        seen.push([edges[0].node.sequence, edges[0].node.document.content]);
        if (!pageInfo.hasNextPage) break;
        after = edges[0].cursor;
      }
      assert.deepEqual(seen, [
        [3, "3"],
        [2, "2"],
        [1, "1"],
      ]);
      const last = await query(page, { id, last: 2 });
      assert.deepEqual(
        last.data?.node.revisions.edges.map(
          ({ node }: { node: { sequence: number } }) => node.sequence,
        ),
        [2, 1],
      );
      assert.equal(last.data?.node.revisions.pageInfo.hasPreviousPage, true);
      for (const cursor of [
        "invalid",
        Buffer.from("DC:x").toString("base64"),
      ]) {
        const invalid = await query(page, { id, first: 1, after: cursor });
        assert.ok((invalid.errors?.length ?? 0) > 0);
      }
    });
  });

  it("ends with a whiteout whose former types are IRIs", async () => {
    await withWriter(async ({ harness, save, change, query }) => {
      const [note] = await save({ type: "Note", content: "gone" });
      assert.ok(note != null);
      const current = await head(harness.db, note.id);
      await change({
        operation: "delete",
        actorId: localActorId,
        objectId: note.id,
        expectedRevisionId: current.id,
      });
      const whiteout = await head(harness.db, note.id);
      const fields = `kind deleted formerTypes document interpreted root { type } diagnostics { reason }`;
      const body = await query(
        `query($id: ID!, $revision: ID!) {
          node(id: $id) { ... on Resource {
            currentRevision { id ${fields} }
            revisions { edges { node { kind } } }
          } }
          revision: node(id: $revision) { ... on ResourceRevision { ${fields} resource { iri } } }
        }`,
        {
          id: globalId("Resource", note.id),
          revision: revisionId(whiteout.id),
        },
      );
      assert.equal(body.errors, undefined);
      const expected = {
        kind: "whiteout",
        deleted: whiteout.deleted?.toString(),
        formerTypes: [`${AS}#Note`],
        document: null,
        interpreted: false,
        root: null,
        diagnostics: [],
      };
      assert.deepEqual(body.data?.node.currentRevision, {
        id: revisionId(whiteout.id),
        ...expected,
      });
      assert.deepEqual(body.data?.node.revisions.edges, [
        { node: { kind: "whiteout" } },
        { node: { kind: "snapshot" } },
      ]);
      // A whiteout's own deletion time does not hide it as a node.
      assert.deepEqual(body.data?.revision, {
        ...expected,
        resource: { iri: note.iri },
      });
    });
  });
});

describe("Access to revisions", () => {
  // The rules for remote resources are still those of their legacy typed
  // rows, so this fixture builds them.
  it("follows the rule of a remote resource the viewer may not read", async () => {
    await withWriter(async ({ harness, auth, query }) => {
      const { db } = harness;
      await seedRemoteActor(db);
      const remoteId = uuidV7();
      const remoteIri = `https://remote.example.com/notes/${remoteId}`;
      await seedObjects(db, {
        id: remoteId,
        actorId: remoteActorId,
        type: "Note",
        iri: remoteIri,
        contentHtml: "private",
        document: { type: "Note", content: "private" },
        addressing: { to: ["https://remote.example.com/users/carol"] },
      });
      const revision = await db.transaction((tx) =>
        captureLegacyResourceRevision(tx, remoteId),
      );
      // A local note addresses the remote one, which reaches its resource.
      const localId = uuidV7();
      await seedObjects(db, {
        id: localId,
        actorId: localActorId,
        type: "Note",
        iri: `${ACTOR_IRI}/${localId}`,
        contentHtml: "public",
        addressing: { to: [remoteIri] },
      });
      const read = `query($local: ID!, $revision: ID!) {
        local: node(id: $local) { ... on Object { to {
          iri currentRevision { document } revisions { edges { node { document } } }
        } } }
        revision: node(id: $revision) { ... on ResourceRevision { document } }
        revisions: nodes(ids: [$revision]) { id }
      }`;
      const variables = {
        local: globalId("Object", localId),
        revision: revisionId(revision),
      };
      // Neither an anonymous viewer nor a member of an instance that did not
      // receive it may read it.
      for (const init of [undefined, auth]) {
        assert.deepEqual(await query(read, variables, init), {
          data: {
            local: {
              to: [
                {
                  iri: remoteIri,
                  currentRevision: null,
                  revisions: { edges: [] },
                },
              ],
            },
            revision: null,
            revisions: [null],
          },
        });
      }
    });
  });

  // Deletion hides typed rows from their existing fields, so the fixture
  // builds one to tell that it hides no revision; a resource without typed
  // rows is covered by the whiteout test above.
  it("keeps the history of a deleted object and author readable", async () => {
    await withWriter(async ({ harness, auth, save, query }) => {
      const { db } = harness;
      const noteId = uuidV7();
      const noteIri = `${ACTOR_IRI}/notes/${noteId}`;
      const document = {
        "@context": AS,
        id: noteIri,
        type: "Note",
        content: "deleted contents",
      };
      await seedObjects(db, {
        id: noteId,
        actorId: localActorId,
        type: "Note",
        iri: noteIri,
        contentHtml: "deleted contents",
        document,
      });
      const snapshot = await db.transaction((tx) =>
        captureLegacyResourceRevision(tx, noteId),
      );
      const [like] = await save({ type: "Like", object: noteIri }, [
        { path: [], kind: "activity" },
      ]);
      assert.ok(like != null);
      await writeTypedResourceRevision(db, {
        resourceId: noteId,
        expectedRevisionId: snapshot,
        kind: "whiteout",
        deleted: Temporal.Now.instant(),
        formerTypes: ["Note"],
      });
      const read = `query($note: ID!, $revision: ID!, $like: ID!) {
        note: node(id: $note) { ... on Resource {
          detail { __typename }
          currentRevision { kind }
          revisions { edges { node { kind document } } }
        } }
        revision: node(id: $revision) { ... on ResourceRevision { document } }
        like: node(id: $like) { ... on Resource { currentRevision { root {
          relations(property: object) { iri resource { iri } }
        } } } }
      }`;
      const variables = {
        note: globalId("Resource", noteId),
        revision: revisionId(snapshot),
        like: globalId("Resource", like.id),
      };
      const expected = {
        data: {
          note: {
            // The existing fields keep hiding what was deleted.
            detail: null,
            currentRevision: { kind: "whiteout" },
            revisions: {
              edges: [
                { node: { kind: "whiteout", document: null } },
                { node: { kind: "snapshot", document } },
              ],
            },
          },
          revision: { document },
          like: {
            currentRevision: {
              root: {
                relations: [{ iri: noteIri, resource: { iri: noteIri } }],
              },
            },
          },
        },
      };
      for (const init of [undefined, auth]) {
        assert.deepEqual(await query(read, variables, init), expected);
      }
      // Nor does deleting the author hide the history.
      await db
        .update(schema.actors)
        .set({ deleted: Temporal.Now.instant() })
        .where(eq(schema.actors.id, localActorId));
      assert.deepEqual(await query(read, variables), expected);
    });
  });

  it("keeps the history of a generic resource received from elsewhere closed", async () => {
    await withWriter(async ({ harness, auth, save }) => {
      const resource = await ensureResource(
        harness.db,
        `https://remote.example/generic/${uuidV7()}`,
      );
      const received = await appendResourceRevision(harness.db, {
        resourceId: resource.id,
        resourceKind: "object",
        expectedRevisionId: null,
        kind: "snapshot",
        capture: "received",
        document: {
          "@context": AS,
          id: resource.iri,
          type: "Note",
          content: "private revision contents",
        },
      });
      const [like] = await save({ type: "Like", object: resource.iri }, [
        { path: [], kind: "activity" },
      ]);
      assert.ok(like != null);
      const history =
        "iri kind currentRevision { document } revisions { edges { node { document } } }";
      const read = `query($id: ID!, $revision: ID!, $like: ID!) {
        node(id: $id) { ... on Resource { ${history} } }
        revision: node(id: $revision) { ... on ResourceRevision { document } }
        like: node(id: $like) { ... on Resource { currentRevision { root {
          relations(property: object) { resource { ${history} } }
        } } } }
      }`;
      const variables = {
        id: globalId("Resource", resource.id),
        revision: revisionId(received.id),
        like: globalId("Resource", like.id),
      };
      const closed = {
        iri: resource.iri,
        kind: "object",
        currentRevision: null,
        revisions: { edges: [] },
      };
      for (const init of [undefined, auth]) {
        const response = await harness.post({ query: read, variables }, init);
        const text = await response.text();
        assert.ok(!text.includes("private revision contents"));
        assert.deepEqual(JSON.parse(text), {
          data: {
            node: closed,
            revision: null,
            like: {
              currentRevision: {
                root: { relations: [{ resource: closed }] },
              },
            },
          },
        });
      }
    });
  });
});

/**
 * Signs in an account: an administrator, an accepted member of the given
 * local instance, or one that is neither.
 * @returns Its account and the request options that authenticate as it.
 */
async function seedViewer(
  db: Database,
  { admin = false, memberOf }: { admin?: boolean; memberOf?: Uuid } = {},
): Promise<{ account: Account; auth: RequestInit }> {
  const id = uuidV7();
  const token = `token-${id}`;
  const [account] = await db
    .insert(schema.accounts)
    .values({
      id,
      email: `${id}@example.com`,
      name: admin ? "Admin" : "Viewer",
      admin,
      created,
    })
    .returning();
  assert.ok(account != null);
  await db.insert(schema.sessions).values({
    id: uuidV7(),
    accountId: id,
    tokenHash: await hashSecret(token),
  });
  if (memberOf != null) {
    await db.insert(schema.instanceMembers).values({
      accountId: id,
      instanceId: memberOf,
      accepted: created,
      created,
    });
  }
  return { account, auth: { headers: { authorization: `Bearer ${token}` } } };
}

/**
 * Opens a second workspace, a local instance apart from the writer's.
 * @returns Its instance ID.
 */
async function seedWorkspace(db: Database): Promise<Uuid> {
  const id = uuidV7();
  await db
    .insert(schema.localInstances)
    .values({ id, slug: "workspace-b", expires });
  await db
    .insert(schema.instances)
    .values({ id, localId: id, created, host: "workspace-b.drfed.org" });
  return id;
}

/**
 * Stores a revision received from elsewhere, addressed as given.
 * @returns Its resource's IRI and the revision ID.
 */
async function receive(
  db: Database,
  iri: string,
  to: readonly string[],
  content: string,
): Promise<{ resourceId: Uuid; revisionId: Uuid }> {
  const resource = await ensureResource(db, iri);
  const current = await loadCurrentResourceRevision(db, resource.id);
  const revision = await appendResourceRevision(db, {
    resourceId: resource.id,
    resourceKind: "object",
    expectedRevisionId: current?.id ?? null,
    kind: "snapshot",
    capture: "received",
    document: { "@context": AS, id: iri, type: "Note", content, to: [...to] },
    addressing: { to: [...to] },
  });
  return { resourceId: resource.id, revisionId: revision.id };
}

/** Links a revision to an inbound delivery to a local instance. */
async function receipt(
  db: Database,
  revision: Uuid,
  instanceId: Uuid = localInstanceId,
): Promise<void> {
  const deliveryId = uuidV7();
  await db.insert(schema.activityDeliveries).values({
    id: deliveryId,
    instanceId,
    direction: "inbound",
    status: "received",
    verificationResult: "verified",
    inboxUrl: `${ACTOR_IRI}/inbox`,
    body: Buffer.from(""),
    completed: Temporal.Now.instant(),
  });
  await db
    .insert(schema.revisionReceipts)
    .values({ deliveryId, revisionId: revision, role: "object" });
}

/**
 * Saves a local activity that embeds a document as its `object`, with the
 * embedding recorded when a source is given.  It records the source
 * directly, without the check a local write makes, as if the writer could
 * read the source when saving and may not any more.
 * @returns The activity's resource ID, IRI, and revision ID.
 */
async function embed(
  db: Database,
  type: string,
  object: JsonObject,
  source?: { revisionId: Uuid; relation: "snapshot" | "derived" },
): Promise<{ resourceId: Uuid; iri: string; revisionId: Uuid }> {
  const resource = await ensureResource(db, `${ACTOR_IRI}/${uuidV7()}`);
  const revision = await appendResourceRevision(db, {
    resourceId: resource.id,
    resourceKind: "activity",
    expectedRevisionId: null,
    kind: "snapshot",
    capture: "local",
    document: {
      "@context": AS,
      id: resource.iri,
      type,
      actor: ACTOR_IRI,
      object,
    },
    ...(source == null
      ? {}
      : {
          embeddings: [
            {
              path: ["object"],
              sourceRevisionId: source.revisionId,
              relation: source.relation,
            },
          ],
        }),
  });
  return {
    resourceId: resource.id,
    iri: resource.iri,
    revisionId: revision.id,
  };
}

const withoutContext = ({ "@context": _, ...rest }: JsonObject): JsonObject =>
  rest;

/**
 * Replaces an IRI in a response, to compare two responses about resources
 * that differ only in their IRIs.
 * @returns The response with the IRI replaced.
 */
const withoutIri = (value: unknown, iri: string): unknown =>
  JSON.parse(JSON.stringify(value).replaceAll(iri, "<iri>"));

describe("Access to revisions across workspaces", () => {
  // Workspace A is the writer's local instance; only workspace B received a
  // private Note from elsewhere.
  const privateNote = async (db: Database) => {
    const workspaceB = await seedWorkspace(db);
    const iri = `https://remote.example/notes/${uuidV7()}`;
    const received = await receive(
      db,
      iri,
      [`${CAROL}/followers`],
      "only workspace B received this",
    );
    await receipt(db, received.revisionId, workspaceB);
    const stored = await head(db, received.resourceId);
    return {
      workspaceB,
      ...received,
      embedded: withoutContext(stored.document as JsonObject),
    };
  };

  it("hides a revision only B received from A, but no local document embedding it", async () => {
    await withWriter(async ({ harness, auth, query }) => {
      const { db } = harness;
      const note = await privateNote(db);
      const memberB = await seedViewer(db, { memberOf: note.workspaceB });
      const outsider = await seedViewer(db);
      const admin = await seedViewer(db, { admin: true });
      const sourced = await embed(db, "Like", note.embedded, {
        revisionId: note.revisionId,
        relation: "snapshot",
      });
      const pasted = await embed(db, "Like", note.embedded);
      const read = `query($note: ID!, $revision: ID!, $sourced: ID!, $pasted: ID!) {
        note: node(id: $note) { ... on Resource {
          currentRevision { id }
          revision(sequence: 1) { id }
          revisions { edges { node { id } } pageInfo { hasNextPage } }
        } }
        revision: node(id: $revision) { ... on ResourceRevision { sequence } }
        revisions: nodes(ids: [$revision]) { id }
        sourced: node(id: $sourced) { ...embedding }
        pasted: node(id: $pasted) { ...embedding }
      }
      fragment embedding on Resource { currentRevision {
        document
        root { relations(property: object) { node {
          document
          source { relation status revision { id } }
        } } }
      } }`;
      const own = revisionId(note.revisionId);
      const variables = {
        note: globalId("Resource", note.resourceId),
        revision: own,
        sourced: globalId("Resource", sourced.resourceId),
        pasted: globalId("Resource", pasted.resourceId),
      };
      const copy = async (resourceId: Uuid, source: unknown) => ({
        currentRevision: {
          document: (await head(db, resourceId)).document,
          root: {
            relations: [{ node: { document: note.embedded, source } }],
          },
        },
      });
      const closed = {
        data: {
          note: {
            currentRevision: null,
            revision: null,
            revisions: { edges: [], pageInfo: { hasNextPage: false } },
          },
          revision: null,
          revisions: [null],
          sourced: await copy(sourced.resourceId, null),
          pasted: await copy(pasted.resourceId, null),
        },
      };
      const open = {
        data: {
          note: {
            currentRevision: { id: own },
            revision: { id: own },
            revisions: {
              edges: [{ node: { id: own } }],
              pageInfo: { hasNextPage: false },
            },
          },
          revision: { sequence: 1 },
          revisions: [{ id: own }],
          sourced: await copy(sourced.resourceId, {
            relation: "snapshot",
            status: "current",
            revision: { id: own },
          }),
          pasted: await copy(pasted.resourceId, null),
        },
      };
      // Neither a member of A, nor of no workspace, nor anyone anonymous may
      // read the revision, even by its ID alone; the local documents that
      // embed it stay whole, and the one that recorded it as its source
      // reads as the pasted one, but for its IRI.
      for (const init of [undefined, auth, outsider.auth]) {
        const response = await harness.post({ query: read, variables }, init);
        const text = await response.text();
        assert.ok(!text.includes(own));
        const body = JSON.parse(text);
        assert.deepEqual(body, closed);
        assert.deepEqual(
          withoutIri(body.data.sourced, sourced.iri),
          withoutIri(body.data.pasted, pasted.iri),
        );
      }
      for (const init of [memberB.auth, admin.auth]) {
        assert.deepEqual(await query(read, variables, init), open);
      }
    });
  });
});

describe("Access to revisions by their own evidence", () => {
  it("opens no earlier private revision by a later public one, nor tells of it by paging", async () => {
    await withWriter(async ({ harness, query }) => {
      const { db } = harness;
      const workspaceB = await seedWorkspace(db);
      const memberB = await seedViewer(db, { memberOf: workspaceB });
      const iri = `https://remote.example/notes/${uuidV7()}`;
      await receive(db, iri, [PUBLIC_IRI], "public at first");
      const hidden = await receive(db, iri, [CAROL], "private");
      await receipt(db, hidden.revisionId, workspaceB);
      await receive(db, iri, [PUBLIC_IRI], "public again");
      const read = `query($id: ID!, $first: Int, $after: String) {
        node(id: $id) { ... on Resource {
          currentRevision { sequence }
          revision(sequence: 2) { sequence }
          revisions(first: $first, after: $after) {
            edges { cursor node { sequence } }
            pageInfo { hasNextPage }
          }
        } }
      }`;
      const id = globalId("Resource", hidden.resourceId);
      const page = async (
        init: RequestInit | undefined,
        first: number,
        after?: string,
      ) => {
        const body = await query(read, { id, first, after }, init);
        assert.equal(body.errors, undefined);
        assert.ok(body.data != null);
        const { currentRevision, revision, revisions } = body.data.node;
        return {
          currentRevision,
          revision,
          sequences: revisions.edges.map(
            ({ node }: { node: { sequence: number } }) => node.sequence,
          ),
          cursor: revisions.edges.at(-1)?.cursor as string | undefined,
          hasNextPage: revisions.pageInfo.hasNextPage,
        };
      };
      const both = await page(undefined, 2);
      assert.deepEqual(
        { ...both, cursor: undefined },
        {
          currentRevision: { sequence: 3 },
          revision: null,
          sequences: [3, 1],
          cursor: undefined,
          hasNextPage: false,
        },
      );
      // Pages of one revision skip the private one as if it did not exist.
      const first = await page(undefined, 1);
      assert.deepEqual([first.sequences, first.hasNextPage], [[3], true]);
      const second = await page(undefined, 1, first.cursor);
      assert.deepEqual([second.sequences, second.hasNextPage], [[1], false]);
      const forB = await page(memberB.auth, 2);
      assert.deepEqual(
        [forB.revision, forB.sequences, forB.hasNextPage],
        [{ sequence: 2 }, [3, 2], true],
      );
    });
  });

  it("keeps an earlier public revision readable after a private one", async () => {
    await withWriter(async ({ harness, query }) => {
      const { db } = harness;
      const iri = `https://remote.example/notes/${uuidV7()}`;
      const first = await receive(db, iri, [PUBLIC_IRI], "public");
      await receive(db, iri, ["https://remote.example/users/carol"], "private");
      const stored = (await db.query.resourceRevisions.findFirst({
        where: { id: first.revisionId },
      }))!;
      const like = await embed(
        db,
        "Like",
        withoutContext(stored.document as JsonObject),
        { revisionId: first.revisionId, relation: "snapshot" },
      );
      const read = `query($id: ID!, $like: ID!) {
        node(id: $id) { ... on Resource {
          currentRevision { id }
          revisions { edges { node { sequence document } } }
        } }
        like: node(id: $like) { ... on Resource { currentRevision { root {
          relations(property: object) { node { source {
            relation status revision { sequence }
          } } }
        } } } }
      }`;
      const variables = {
        id: globalId("Resource", first.resourceId),
        like: globalId("Resource", like.resourceId),
      };
      const sourceOf = (status: string | null) => ({
        currentRevision: {
          root: {
            relations: [
              {
                node: {
                  source: {
                    relation: "snapshot",
                    status,
                    revision: { sequence: 1 },
                  },
                },
              },
            ],
          },
        },
      });
      const response = await harness.post({ query: read, variables });
      const text = await response.text();
      assert.ok(!text.includes('"private"'));
      assert.deepEqual(JSON.parse(text), {
        data: {
          node: {
            currentRevision: null,
            revisions: {
              edges: [{ node: { sequence: 1, document: stored.document } }],
            },
          },
          // Whether a later revision exists is not told without reading it.
          like: sourceOf(null),
        },
      });
      const admin = await seedViewer(db, { admin: true });
      const body = await query(read, variables, admin.auth);
      assert.equal(body.data?.node.revisions.edges.length, 2);
      assert.deepEqual(body.data?.like, sourceOf("superseded"));
    });
  });
});

describe("DocumentNode.source", () => {
  const source = `query($id: ID!) { node(id: $id) { ... on Resource {
    currentRevision { root { source { relation } relations(property: object) {
      node { source { relation status revision { id sequence } } }
    } } }
  } } }`;

  const read = async (
    query: Writer["query"],
    resourceId: Uuid,
  ): Promise<unknown> => {
    const body = await query(source, { id: globalId("Resource", resourceId) });
    assert.equal(body.errors, undefined);
    const root = body.data?.node.currentRevision.root;
    // The root is no embedded document.
    assert.equal(root.source, null);
    return root.relations[0].node.source;
  };

  it("tells snapshots and derived documents and where their sources stand", async () => {
    await withWriter(async ({ harness, query }) => {
      const { db } = harness;
      const note = await ensureResource(db, `${ACTOR_IRI}/notes/${uuidV7()}`);
      const document = { id: note.iri, type: "Note", content: "1" };
      const first = await appendResourceRevision(db, {
        resourceId: note.id,
        resourceKind: "object",
        expectedRevisionId: null,
        kind: "snapshot",
        capture: "local",
        document: { "@context": AS, ...document },
      });
      const create = await embed(db, "Create", document, {
        revisionId: first.id,
        relation: "snapshot",
      });
      const announce = await embed(
        db,
        "Announce",
        { ...document, content: "changed" },
        { revisionId: first.id, relation: "derived" },
      );
      const pasted = await embed(db, "Like", document);
      const expected = (relation: string, status: string) => ({
        relation,
        status,
        revision: { id: revisionId(first.id), sequence: 1 },
      });
      assert.deepEqual(
        await read(query, create.resourceId),
        expected("snapshot", "current"),
      );
      assert.deepEqual(
        await read(query, announce.resourceId),
        expected("derived", "current"),
      );
      // A document embedded without a recorded source has an unknown one.
      assert.equal(await read(query, pasted.resourceId), null);
      const second = await appendResourceRevision(db, {
        resourceId: note.id,
        resourceKind: "object",
        expectedRevisionId: first.id,
        kind: "snapshot",
        capture: "local",
        document: { "@context": AS, ...document, content: "2" },
      });
      assert.deepEqual(
        await read(query, create.resourceId),
        expected("snapshot", "superseded"),
      );
      await appendResourceRevision(db, {
        resourceId: note.id,
        resourceKind: "object",
        expectedRevisionId: second.id,
        kind: "whiteout",
        deleted: Temporal.Now.instant(),
        formerTypes: ["Note"],
      });
      assert.deepEqual(
        await read(query, create.resourceId),
        expected("snapshot", "deleted"),
      );
    });
  });
});
