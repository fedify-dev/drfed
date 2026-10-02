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

// oxlint-disable id-length max-statements

import assert from "node:assert/strict";
import { it } from "node:test";

import { migrate, relations, schema } from "@drfed/models";
import {
  jwkThumbprint,
  observeKeyVersion,
  toPublicJwk,
} from "@drfed/models/key";
import { uuidV7 } from "@drfed/models/uuid";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

const ed = {
  kty: "OKP",
  crv: "Ed25519",
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
};

it("matches RFC 7638 and RFC 8037 thumbprint vectors", async () => {
  assert.equal(
    await jwkThumbprint({
      kty: "RSA",
      e: "AQAB",
      alg: "RS256",
      kid: "2011-04-29",
      n:
        "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAt" +
        "VT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn6" +
        "4tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FD" +
        "W2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n9" +
        "1CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINH" +
        "aQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
    }),
    "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
  );
  assert.equal(
    await jwkThumbprint(ed),
    "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k",
  );
  assert.equal(
    await jwkThumbprint({ ...ed, ext: true, key_ops: ["verify"] }),
    await jwkThumbprint(ed),
  );
  assert.deepEqual(toPublicJwk({ ...ed, ext: true, key_ops: ["verify"] }), ed);
  assert.throws(() => toPublicJwk({ ...ed, d: "private" }), TypeError);
  await assert.rejects(jwkThumbprint({ kty: "EC" }), TypeError);
});

it("reuses A after A, B, A without mutating material or firstSeen", async () => {
  const client = new PGlite();
  try {
    await migrate({ credentials: { driver: "pglite", client } });
    const db = drizzle({ client, schema, relations });
    const iri = "https://remote.example/key";
    const first = Temporal.Instant.from("2026-01-01T00:00:00Z");
    const last = first.add({ hours: 2 });
    const a = await observeKeyVersion(db, {
      iri,
      publicKey: ed,
      observed: first,
    });
    const b = await observeKeyVersion(db, {
      iri,
      publicKey: { ...ed, x: "different" },
      observed: first.add({ hours: 1 }),
    });
    const again = await observeKeyVersion(db, {
      iri,
      publicKey: { ...ed, kid: "ignored-change" },
      observed: last,
    });
    assert.notEqual(a.id, b.id);
    assert.equal(again.id, a.id);
    assert.equal(again.firstSeen.toString(), first.toString());
    assert.equal(again.lastSeen.toString(), last.toString());
    assert.deepEqual(again.publicKey, ed);
    assert.equal(await db.$count(schema.keys), 1);
    assert.equal(await db.$count(schema.keyVersions), 2);
    const earlier = await observeKeyVersion(db, {
      iri,
      publicKey: ed,
      observed: first,
    });
    assert.equal(earlier.lastSeen.toString(), last.toString());
    await assert.rejects(
      db.insert(schema.keyVersions).values({
        id: uuidV7(),
        keyId: a.keyId,
        fingerprint: "private",
        publicKey: { ...ed, d: "private" },
        firstSeen: first,
        lastSeen: last,
      }),
    );
  } finally {
    await client.close();
  }
});
