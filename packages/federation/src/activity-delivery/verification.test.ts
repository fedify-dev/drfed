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

import assert from "node:assert/strict";
import { it } from "node:test";

import { summarizeVerification } from "@drfed/federation/activity-delivery";
import {
  type InboxAuthentication,
  type InboxRequestOutcome,
  type InboxRequestReport,
  type InboxSignatureCheck,
  type InboxVerificationAttempt,
  type InboxVerificationKey,
  generateCryptoKeyPair,
} from "@fedify/fedify";

const actor = new URL("https://remote.example/alice");
const id = new URL(`${actor.href}#key`);
const pair = await generateCryptoKeyPair();
const key: InboxVerificationKey = {
  type: "cryptographicKey",
  id,
  ownerId: actor,
  publicKey: pair.publicKey,
};
const success = (
  snapshot = key,
  declaration: string | null = id.href,
): InboxSignatureCheck & { status: "verified" } => ({
  mechanism: "http",
  spec: "draft-cavage-http-signatures-12",
  label: null,
  declaredKeyId: declaration,
  triedKeys: [snapshot],
  status: "verified",
  key: snapshot,
});
const invalid: InboxSignatureCheck = {
  mechanism: "http",
  spec: "draft-cavage-http-signatures-12",
  label: null,
  declaredKeyId: id.href,
  triedKeys: [key],
  status: "rejected",
  reason: { type: "invalidSignature" },
};
const subject = { id: actor, pointer: "" };
const verified = (
  check = success(),
): InboxVerificationAttempt & { status: "verified" } => ({
  mechanism: "http",
  subject,
  checks: [invalid, check],
  status: "verified",
  signatures: [check],
});
const rejected = (
  checks: readonly InboxSignatureCheck[] = [invalid],
): InboxVerificationAttempt => ({
  mechanism: "objectIntegrity",
  subject,
  checks,
  status: "rejected",
  reason: { type: "signatureVerificationFailed" },
});
function report(
  attempts: readonly InboxVerificationAttempt[] = [],
  authentication: InboxAuthentication = {
    status: "rejected",
    reason: { type: "verificationFailed" },
  },
  outcome: InboxRequestOutcome = {
    type: "response",
    status: 401,
    disposition: "rejected",
    reason: "authentication",
  },
): InboxRequestReport {
  return {
    inbox: { kind: "shared", recipient: null },
    payload: { status: "parsed", value: null },
    activity: null,
    attempts,
    authentication,
    outcome,
  };
}

it("distinguishes missing reports, absent checks, preparation failure and signature bypass", () => {
  assert.equal(summarizeVerification(undefined).result, "unobserved");
  const noSignature: InboxVerificationAttempt = {
    mechanism: "http",
    subject,
    checks: [],
    status: "rejected",
    reason: { type: "noSignature" },
  };
  assert.equal(
    summarizeVerification(report([noSignature])).result,
    "no_signature",
  );
  const error: InboxVerificationAttempt = {
    mechanism: "objectIntegrity",
    subject,
    checks: [],
    status: "error",
    error: new Error("parse"),
  };
  const thrown: InboxRequestOutcome = {
    type: "exception",
    stage: "verify",
    error: new Error("parse"),
  };
  const before = summarizeVerification(
    report([error], { status: "notDetermined" }, thrown),
  );
  assert.equal(before.result, "unattempted");
  assert.equal(before.mechanism, null);
  assert.equal(before.detail, "Error: parse");
  assert.equal(
    summarizeVerification(report([], { status: "skipped" })).result,
    "no_signature",
  );
  assert.equal(
    summarizeVerification(report([error], { status: "skipped" })).result,
    "invalid_signature",
  );
});

it("selects a successful HTTP check after a failed signature and retains declaration separately", () => {
  const declared = "https://remote.example/compatible#key";
  const check = success(key, declared);
  const attempt = verified(check);
  const summary = summarizeVerification(
    report(
      [attempt],
      { status: "verified", attempts: [attempt] },
      { type: "response", status: 202, disposition: "processed" },
    ),
  );
  assert.equal(summary.result, "verified");
  assert.equal(summary.key, key);
  assert.equal(summary.keyIri, id.href);
  assert.equal(summary.signedKeyIri, declared);
  const nullId = success({ ...key, id: null }, declared);
  assert.equal(
    summarizeVerification(report([verified(nullId)])).keyIri,
    declared,
  );
  assert.equal(
    summarizeVerification(
      report([verified(success({ ...key, id: null }, "invalid"))]),
    ).keyIri,
    null,
  );
});

it("does not call a partly valid proof set verified, and preserves the failed refresh's tried key", () => {
  const fetch: InboxSignatureCheck = {
    ...invalid,
    reason: {
      type: "keyFetchError",
      keyId: id,
      result: { error: new TypeError("offline") },
    },
  };
  const summary = summarizeVerification(report([rejected([success(), fetch])]));
  assert.equal(summary.result, "key_fetch_error");
  assert.equal(summary.key, key);
  assert.equal(summary.detail, "keyFetchError: TypeError: offline");
  assert.equal(
    summarizeVerification(report([rejected([success(), invalid])])).result,
    "invalid_signature",
  );
  assert.equal(
    summarizeVerification(report([rejected([success()])])).result,
    "invalid_signature",
  );
  assert.equal(
    summarizeVerification(report([rejected([])])).result,
    "invalid_signature",
  );
});

it("keeps cryptographic success for attribution rejection and selects root over embedded proofs", () => {
  const ld: InboxVerificationAttempt = {
    ...rejected([success()]),
    mechanism: "linkedData",
    status: "rejected",
    reason: { type: "uncoveredAttribution", attributionIds: [actor] },
  };
  const noHttp: InboxVerificationAttempt = {
    mechanism: "http",
    subject,
    checks: [],
    status: "rejected",
    reason: { type: "noSignature" },
  };
  const summary = summarizeVerification(report([ld, noHttp]));
  assert.equal(summary.result, "verified");
  assert.equal(summary.mechanism, "ld_signature");
  assert.match(summary.detail ?? "", /uncoveredAttribution/u);
  const root = verified();
  const embedded = {
    ...verified(),
    mechanism: "objectIntegrity",
    subject: { id: actor, pointer: "/object" },
  } as const;
  assert.equal(
    summarizeVerification(report([root, embedded])).mechanism,
    "http_signature",
  );
  assert.equal(
    summarizeVerification(report([embedded])).mechanism,
    "object_integrity_proof",
  );
});

it("uses final refusal reasons without overwriting valid cryptographic checks", () => {
  const attempt = verified();
  for (const [reason, expected] of [
    [{ type: "actorKeyMismatch", key, actorIds: [actor] }, "actorKeyMismatch"],
    [{ type: "invalidNonce" }, "invalidNonce"],
    [
      { type: "proofPolicy", policy: "portableActor" },
      "proofPolicy: portableActor",
    ],
  ] as const) {
    const summary = summarizeVerification(
      report([attempt], { status: "rejected", reason }),
    );
    assert.equal(summary.result, "verified");
    assert.ok(summary.detail?.startsWith(expected));
  }
  const parsed = summarizeVerification(
    report(
      [attempt],
      { status: "notDetermined" },
      {
        type: "response",
        status: 400,
        disposition: "rejected",
        reason: "invalidActivity",
      },
    ),
  );
  assert.equal(parsed.result, "verified");
  assert.equal(parsed.detail, "invalidActivity");
  assert.equal(
    summarizeVerification(
      report([rejected()], undefined, {
        type: "response",
        status: 202,
        disposition: "customResponse",
      }),
    ).detail,
    null,
  );
  assert.equal(
    summarizeVerification(
      report([], undefined, {
        type: "response",
        status: 500,
        disposition: "failed",
        reason: "enqueueError",
        error: new Error("queue"),
      }),
    ).detail,
    "enqueueError: Error: queue",
  );
});
