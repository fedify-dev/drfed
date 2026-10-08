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

import type { Database } from "@drfed/models";
import { observeKeyVersion } from "@drfed/models/key";
import type {
  ActivityDeliveryVerificationMechanism,
  ActivityDeliveryVerificationResult,
} from "@drfed/models/schema";
import type { Uuid } from "@drfed/models/uuid";
import {
  type InboxRequestReport,
  type InboxSignatureCheck,
  type InboxVerificationAttempt,
  type InboxVerificationKey,
  exportJwk,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";

import { iri } from "./describe.ts";
import { describeError } from "./queue.ts";

const logger = getLogger(["drfed", "federation", "activity-delivery"]);
const mechanisms = {
  http: "http_signature",
  linkedData: "ld_signature",
  objectIntegrity: "object_integrity_proof",
} as const;

export interface VerificationSummary {
  readonly mechanism: ActivityDeliveryVerificationMechanism | null;
  readonly result: ActivityDeliveryVerificationResult;
  readonly key: InboxVerificationKey | null;
  readonly keyIri: string | null;
  readonly signedKeyIri: string | null;
  readonly detail: string | null;
}

export interface VerificationObservation {
  readonly mechanism: ActivityDeliveryVerificationMechanism | null;
  readonly result: ActivityDeliveryVerificationResult;
  readonly keyId: Uuid | null;
  readonly signedKeyIri: string | null;
  readonly detail: string | null;
}

/**
 * Read the HTTP key declaration without verifying. Invalid URLs stay raw.
 * @returns A URL declaration, or null.
 */
export function declaredKeyId(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  for (const value of [
    headers.get("signature-input"),
    headers.get("signature"),
    authorization != null && /^signature\s/iu.test(authorization)
      ? authorization
      : null,
  ]) {
    const keyId = value?.match(/keyid="(?<keyId>[^"]*)"/iu)?.groups?.keyId;
    if (keyId != null) return iri(keyId);
  }
  return null;
}

function attributionFailure(attempt: InboxVerificationAttempt): boolean {
  return (
    attempt.status === "rejected" &&
    ["uncoveredAttribution", "missingOwner", "proofPolicy"].includes(
      attempt.reason.type,
    ) &&
    attempt.checks.some((check) => check.status === "verified")
  );
}

function checkDetail(check: InboxSignatureCheck | undefined): string | null {
  if (check?.status === "error") return describeError(check.error);
  if (check?.status !== "rejected") return null;
  if (check.reason.type === "invalidSignature") return "invalidSignature";
  const { result } = check.reason;
  return `keyFetchError: ${"status" in result ? result.status : describeError(result.error)}`;
}

function authenticationFailure(
  authentication: InboxRequestReport["authentication"],
): string | null {
  if (authentication.status !== "rejected") return null;
  const { reason } = authentication;
  switch (reason.type) {
    case "actorKeyMismatch":
      return `actorKeyMismatch: ${reason.key.id?.href ?? "unknown key"}; actors: ${reason.actorIds.map((id) => id.href).join(", ")}`;
    case "invalidNonce":
      return "invalidNonce";
    case "proofPolicy":
      return `proofPolicy: ${reason.policy}${reason.detail == null ? "" : `: ${reason.detail.type}`}`;
    default:
      return null;
  }
}

function refusalDetail(
  report: InboxRequestReport,
  attempt: InboxVerificationAttempt | undefined,
  check: InboxSignatureCheck | undefined,
): string | null {
  const { outcome, authentication } = report;
  if (outcome.type === "exception") return describeError(outcome.error);
  if (outcome.status >= 200 && outcome.status < 300) return null;
  if (outcome.disposition === "failed") {
    return outcome.error === undefined
      ? outcome.reason
      : `${outcome.reason}: ${describeError(outcome.error)}`;
  }
  if (
    outcome.disposition === "rejected" &&
    outcome.reason !== "authentication"
  ) {
    return outcome.reason;
  }
  const authenticationDetail = authenticationFailure(authentication);
  if (authenticationDetail != null) return authenticationDetail;
  if (attempt?.status === "error") return describeError(attempt.error);
  if (attempt?.status === "rejected") {
    switch (attempt.reason.type) {
      case "uncoveredAttribution":
        return `uncoveredAttribution: ${attempt.reason.attributionIds.map((id) => id.href).join(", ")}`;
      case "missingOwner":
        return "missingOwner";
      case "proofPolicy":
        return `proofPolicy: ${attempt.reason.reason.type}`;
      default:
        return checkDetail(check) ?? attempt.reason.type;
    }
  }
  return checkDetail(check);
}

function httpDeclaration(
  report: InboxRequestReport | undefined,
  headers: Headers,
): string | null {
  const http =
    report?.attempts.filter((attempt) => attempt.mechanism === "http") ?? [];
  const httpCheck =
    http
      .find((attempt) => attempt.status === "verified")
      ?.checks.find((check) => check.status === "verified") ??
    http.flatMap((attempt) => attempt.checks)[0];
  return iri(httpCheck?.declaredKeyId) ?? declaredKeyId(headers);
}

function selectAttempt(
  report: InboxRequestReport,
): InboxVerificationAttempt | undefined {
  const meaningful = report.attempts.filter(
    (attempt) =>
      attempt.checks.length > 0 ||
      (attempt.status === "rejected" &&
        attempt.reason.type !== "noSignature") ||
      (attempt.status === "error" &&
        report.authentication.status !== "notDetermined"),
  );
  const root = meaningful.filter(
    (attempt) =>
      attempt.subject.pointer == null || attempt.subject.pointer === "",
  );
  const eligible = root.length > 0 ? root : meaningful;
  const authenticated = report.authentication.status === "verified";
  return authenticated
    ? report.authentication.attempts.find(
        (candidate) =>
          eligible.includes(candidate) && candidate.signatures.length > 0,
      )
    : (eligible.findLast(
        (candidate) =>
          candidate.status === "verified" && candidate.signatures.length > 0,
      ) ??
        eligible.findLast(attributionFailure) ??
        eligible.at(-1));
}

function selectedCheck(
  attempt: InboxVerificationAttempt,
  verified: boolean,
): InboxSignatureCheck | undefined {
  return attempt.status === "verified"
    ? attempt.signatures[0]
    : verified
      ? attempt.checks.find((candidate) => candidate.status === "verified")
      : (attempt.checks.findLast(
          (candidate) => candidate.status !== "verified",
        ) ?? attempt.checks.at(-1));
}

/**
 * Project Fedify's completion report into one representative verification.
 * Root evaluations take precedence over embedded portable objects. A successful
 * authentication wins; otherwise retain cryptographic success despite policy
 * rejection, or the last meaningful failed evaluation. No request is verified
 * again, and partial cryptographic failure is never a successful proof set.
 * @returns A lossy summary, including the actual key of the selected check.
 */
export function summarizeVerification(
  report: InboxRequestReport | undefined,
  headers: Headers = new Headers(),
): VerificationSummary {
  const signedKeyIri = httpDeclaration(report, headers);
  const empty = {
    mechanism: null,
    key: null,
    keyIri: null,
    signedKeyIri,
  } as const;
  if (report == null) return { ...empty, result: "unobserved", detail: null };
  const authenticated = report.authentication.status === "verified";
  const attempt = selectAttempt(report);
  if (attempt == null) {
    return {
      ...empty,
      result:
        !authenticated && report.authentication.status === "notDetermined"
          ? "unattempted"
          : "no_signature",
      detail: refusalDetail(report, undefined, undefined),
    };
  }
  const verified = attempt.status === "verified" || attributionFailure(attempt);
  const check = selectedCheck(attempt, verified);
  const result = verified
    ? "verified"
    : check?.status === "rejected" && check.reason.type === "keyFetchError"
      ? "key_fetch_error"
      : "invalid_signature";
  const key =
    check?.status === "verified"
      ? check.key
      : (check?.triedKeys.at(-1) ?? null);
  return {
    mechanism: mechanisms[attempt.mechanism],
    result,
    key,
    keyIri: iri(key?.id?.href) ?? iri(check?.declaredKeyId),
    signedKeyIri,
    detail: refusalDetail(report, attempt, check),
  };
}

/**
 * Record the selected actual public key without depending on Fedify's cache.
 * @returns The verification observation, including persistence failures.
 */
export async function observeVerification(
  db: Database,
  headers: Headers,
  report: InboxRequestReport | undefined,
): Promise<VerificationObservation> {
  try {
    const summary = summarizeVerification(report, headers);
    const version =
      summary.key == null || summary.keyIri == null
        ? null
        : await observeKeyVersion(db, {
            iri: summary.keyIri,
            publicKey: await exportJwk(summary.key.publicKey),
          });
    return {
      mechanism: summary.mechanism,
      result: summary.result,
      keyId: version?.id ?? null,
      signedKeyIri: summary.signedKeyIri,
      detail: summary.detail,
    };
  } catch (error) {
    logger.error("Could not observe inbox verification: {error}", { error });
    return {
      mechanism: null,
      result: "unobserved",
      keyId: null,
      signedKeyIri: declaredKeyId(headers),
      detail: `Verification observation failed: ${describeError(error)}`,
    };
  }
}
