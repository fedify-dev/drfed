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

// oxlint-disable no-await-in-loop max-statements

import assert from "node:assert/strict";
import { it } from "node:test";

import { recordOutbound } from "@drfed/models/activity-delivery";
import type { Uuid } from "@drfed/models/uuid";

import { withTestHarness } from "../harness.test.ts";
import {
  accepted,
  globalId,
  localActorId,
  localInstanceId,
  seedAuthenticatedLocalInstance,
  seedLocalActor,
  seedObjects,
} from "../seed.test.ts";
import {
  type Documents,
  addActor,
  createOf,
  createRecorder,
  deliveryGlobalId,
  findDeliveries,
  hostA,
  hostB,
  otherInstanceId,
  seedAccount,
  seedOtherInstance,
  signed,
} from "./inbox-fixture.test.ts";

interface Connection {
  readonly edges: readonly {
    readonly cursor: string;
    readonly node?: { readonly uuid: Uuid };
  }[];
  readonly pageInfo: { readonly hasNextPage: boolean };
}

it("shows an activity's deliveries only of the instances the viewer may read", async () => {
  await withTestHarness(async ({ db, post: graphql }) => {
    const member = await seedAuthenticatedLocalInstance(db);
    await seedLocalActor(db);
    await seedOtherInstance(db);
    const admin = await seedAccount(db, "admin", { admin: true });
    const pending = await seedAccount(db, "pending", {
      member: { instanceId: localInstanceId, accepted: null },
    });
    const stranger = await seedAccount(db, "stranger");
    const other = await seedAccount(db, "other", {
      member: { instanceId: otherInstanceId, accepted },
    });
    const localActivityId: Uuid = "01990000-0000-7000-8000-000000000001";
    const localActivityIri = `https://${hostA}/ap/creates/${localActivityId}`;
    await seedObjects(db, {
      id: "01990000-0000-7000-8000-000000000002",
      iri: `https://${hostA}/users/${localActorId}/notes/1`,
      actorId: localActorId,
      type: "Note",
      contentHtml: "<p>local</p>",
      activityId: localActivityId,
    });
    const documents: Documents = new Map();
    const alice = await addActor(documents, "https://remote.example/users/a");
    const localActorIri = `https://${hostA}/users/${localActorId}`;
    const local = await addActor(documents, localActorIri);
    const { send } = await createRecorder(db, documents);
    // A remote Create both instances receive, and a local one A sends to B.
    const body = createOf(alice.iri, "1");
    for (const host of [hostA, hostB]) {
      assert.equal((await send(await signed(alice, body, host))).status, 202);
    }
    const localBody = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: localActivityIri,
      type: "Create",
      actor: localActorIri,
      object: `https://${hostA}/users/${localActorId}/notes/1`,
    };
    assert.equal(
      (await send(await signed(local, localBody, hostB))).status,
      202,
    );
    const sent = await recordOutbound(db, {
      instanceId: localInstanceId,
      actorId: localActorId,
      activityIri: localActivityIri,
      activityId: localActivityId,
      inboxUrl: `https://${hostB}/inbox`,
    });
    const [receivedA, receivedB, localB] = await findDeliveries(db);
    const remoteActivity = await db.query.activities.findFirst({
      where: { resource: { iri: "https://remote.example/activities/1" } },
    });
    assert.ok(remoteActivity != null && receivedA != null);
    assert.ok(receivedB != null && localB != null);
    for (const row of [receivedA, receivedB]) {
      assert.equal(row.activityId, remoteActivity.id);
    }
    assert.equal(localB.activityId, localActivityId);

    const deliveries = async (
      activityId: Uuid,
      init: RequestInit | undefined,
      { first = 10, node = true } = {},
    ): Promise<Connection | undefined> => {
      const response = await graphql(
        {
          query: `
            query ($id: ID!, $first: Int) {
              node(id: $id) {
                ... on Activity {
                  deliveries(first: $first) {
                    edges { cursor ${node ? "node { uuid }" : ""} }
                    pageInfo { hasNextPage }
                  }
                }
              }
            }
          `,
          variables: { id: globalId("Activity", activityId), first },
        },
        init,
      );
      const { data, errors } = (await response.json()) as {
        data?: { node: { deliveries: Connection } | null };
        errors?: unknown;
      };
      assert.equal(errors, undefined);
      return data?.node?.deliveries;
    };
    const uuids = (connection: Connection | undefined) =>
      connection?.edges.map((edge) => edge.node?.uuid);

    assert.deepEqual(uuids(await deliveries(remoteActivity.id, member)), [
      receivedA.id,
    ]);
    assert.deepEqual(uuids(await deliveries(localActivityId, member)), [
      sent.id,
    ]);
    assert.deepEqual(uuids(await deliveries(localActivityId, other)), [
      localB.id,
    ]);
    // Neither cursors nor page info tell of the rows left out.
    for (const first of [1, 10]) {
      const connection = await deliveries(remoteActivity.id, member, {
        first,
        node: false,
      });
      assert.equal(connection?.edges.length, 1);
      assert.equal(connection?.pageInfo.hasNextPage, false);
    }
    for (const viewer of [undefined, stranger, pending]) {
      for (const activityId of [remoteActivity.id, localActivityId]) {
        const connection = await deliveries(activityId, viewer, {
          node: false,
        });
        assert.deepEqual(connection?.edges, []);
        assert.equal(connection?.pageInfo.hasNextPage, false);
      }
    }
    assert.deepEqual(
      new Set(uuids(await deliveries(remoteActivity.id, admin))),
      new Set([receivedA.id, receivedB.id]),
    );
    assert.deepEqual(
      new Set(uuids(await deliveries(localActivityId, admin))),
      new Set([sent.id, localB.id]),
    );
    const paged = await deliveries(remoteActivity.id, admin, { first: 1 });
    assert.equal(paged?.edges.length, 1);
    assert.equal(paged?.pageInfo.hasNextPage, true);

    // A delivery of another instance is refused by its own check, as before.
    const response = await graphql(
      {
        query: `
          query ($id: ID!) {
            node(id: $id) { ... on ActivityDelivery { uuid } }
          }
        `,
        variables: { id: deliveryGlobalId(receivedB.id) },
      },
      member,
    );
    const { data, errors } = (await response.json()) as {
      data?: { node: unknown };
      errors?: readonly { readonly message: string }[];
    };
    assert.equal(data?.node ?? null, null);
    assert.ok((errors?.length ?? 0) > 0);
    // The delivery, in turn, names the activity it is linked to.
    const linked = await graphql(
      {
        query: `
          query ($id: ID!) {
            node(id: $id) {
              ... on ActivityDelivery { activity { iri } }
            }
          }
        `,
        variables: { id: deliveryGlobalId(sent.id) },
      },
      member,
    );
    assert.deepEqual(await linked.json(), {
      data: { node: { activity: { iri: localActivityIri } } },
    });
  });
});
