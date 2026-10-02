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
  ActivityLogVerificationMechanism,
  ActivityLogVerificationResult,
} from "@drfed/models/schema";
import type { Uuid } from "@drfed/models/uuid";
import { detachSignature, exportJwk } from "@fedify/fedify";
import { Activity, type DocumentLoader } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";

import { iri } from "./describe.ts";
import { trackedKey } from "./keycache.ts";
import type {
  ObservedKeyFetch,
  ObservedSpan,
  ObservedVerification,
  Report,
} from "./tracking.ts";

const logger = getLogger(["drfed", "graphql", "activity-log"]);

export interface VerificationObservation {
  readonly mechanism: ActivityLogVerificationMechanism | null;
  readonly result: ActivityLogVerificationResult;
  readonly keyId: Uuid | null;
  readonly signedKeyIri: string | null;
  readonly detail: string | null;
}

/** What Fedify's report says of a verification. */
export interface Verdict {
  readonly mechanism: ActivityLogVerificationMechanism | null;
  /**
   * Whether the signature or proof verified, which is not whether Fedify took
   * it to authenticate the activity, nor whether it accepted the activity.
   */
  readonly result: ActivityLogVerificationResult;
  readonly keyIri?: string | null;
  /**
   * The key fetches Fedify measured for the one verification the verdict is
   * of, which hold the key it used.
   */
  readonly keyFetches?: readonly ObservedKeyFetch[];
  readonly detail?: string | null;
}

/**
 * The signatures and proofs a document carries, whether or not tried; they
 * count as tried only when Fedify went on to HTTP signatures.
 */
export interface Carried {
  /** The key of a Linked Data Signature Fedify would try, if any. */
  readonly ldKeyIri: string | null;
  /** The verification method of each proof; null when not known. */
  readonly proofMethods: readonly (string | null)[];
}

/**
 * Mirror of the check in Fedify's inbox handler, which is not exported.
 * @returns Whether Fedify would try Linked Data Signatures on the document.
 */
export function hasLdSignature(
  json: unknown,
): json is { signature: { creator: string } } {
  if (typeof json !== "object" || json == null || !("signature" in json)) {
    return false;
  }
  const { signature } = json;
  return (
    typeof signature === "object" &&
    signature != null &&
    "type" in signature &&
    signature.type === "RsaSignature2017" &&
    "creator" in signature &&
    typeof signature.creator === "string" &&
    "created" in signature &&
    typeof signature.created === "string" &&
    "signatureValue" in signature &&
    typeof signature.signatureValue === "string"
  );
}

/**
 * Read the `keyId` an HTTP signature declares, without verifying.
 * @returns The declared key IRI, or null when it is missing or not a URL.
 */
export function declaredKeyId(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  const candidates = [
    headers.get("signature-input"),
    headers.get("signature"),
    authorization != null && /^signature\s/iu.test(authorization)
      ? authorization
      : null,
  ];
  for (const value of candidates) {
    const keyId = value?.match(/keyid="(?<keyId>[^"]*)"/iu)?.groups?.keyId;
    if (keyId != null) return iri(keyId);
  }
  return null;
}

const refuse: DocumentLoader = () =>
  Promise.reject(new TypeError("Documents are not fetched while observing."));

/**
 * Find the proofs of a document as JSON-LD, as Fedify does, however it spells
 * `proof`, and without fetching proofs it only references.
 * @returns The verification method of each proof.
 */
export async function proofMethods(
  json: unknown,
  contextLoader: DocumentLoader,
): Promise<(string | null)[]> {
  const options = { contextLoader, documentLoader: refuse };
  const activity = await Activity.fromJsonLd(json, options).catch(() => null);
  if (activity == null) return [];
  const embedded: (string | null)[] = [];
  for await (const proof of activity.getProofs({
    ...options,
    suppressError: true,
  })) {
    embedded.push(proof.verificationMethodId?.href ?? null);
  }
  return [...embedded, ...activity.proofIds.map(() => null)];
}

const reportedIri = (span: ObservedSpan | undefined, attribute: string) =>
  iri(span?.attributes.get(attribute));

const failure = (kind: string, result: string | undefined) =>
  result === "error" ? `Fedify could not verify the ${kind}.` : null;

/**
 * Why the last key fetch of a verification brought no usable key, which left
 * the signature unchecked, or checked only against a cached key that did not
 * verify.  Fedify counts the lookup behind the fetch.
 * @returns The status the server of the key answered with, `cached` for the
 *          record of an earlier failure, or otherwise the
 *          `activitypub.lookup.result`; null when the fetch brought a key, or
 *          none was made.
 */
function keyFetchFailure(
  measured: ObservedVerification | undefined,
): string | null {
  const fetched = measured?.keyFetches.at(-1);
  if (fetched?.result !== "error") return null;
  const { lookup } = fetched;
  if (lookup == null) return "error";
  if (lookup.statusCode != null) return String(lookup.statusCode);
  return lookup.result === "hit" ? "cached" : lookup.result;
}

const accepted: Pick<Verdict, "result" | "detail"> = {
  result: "verified",
  detail: null,
};

/**
 * Fedify takes proofs to authenticate an activity only when the controllers
 * of their keys cover every actor and attribution it names.
 */
const unauthenticated =
  "Every Object Integrity Proof Fedify tried verified, but it did not " +
  "accept them as authenticating the activity.";

/**
 * Tell a verification that failed for want of a key from one whose signature
 * did not verify.
 * @param kind What was verified, as the detail of a verification that threw
 *             names it.
 * @returns The result and detail of the refusal.
 */
function refusal(
  kind: string,
  measured: ObservedVerification | undefined,
): Pick<Verdict, "result" | "detail"> {
  const cause = keyFetchFailure(measured);
  return cause == null
    ? { result: "invalid_signature", detail: failure(kind, measured?.result) }
    : { result: "key_fetch_error", detail: `keyFetchError: ${cause}` };
}

/**
 * Read an `http_signatures.verify` span.  Fedify tries HTTP signatures only
 * after the other mechanisms failed, so without an HTTP signature the verdict
 * is that of the mechanism tried before.
 * @param measured What Fedify measured of the verification.
 * @returns The verdict of the HTTP signature, or of the mechanism before it.
 */
function httpVerdict(
  http: ObservedSpan,
  before: Verdict | null,
  measured: ObservedVerification | undefined,
): Verdict {
  const tried = {
    mechanism: "http_signature",
    keyIri: reportedIri(http, "http_signatures.key_id"),
    keyFetches: measured?.keyFetches ?? [],
  } as const;
  if (http.attributes.get("http_signatures.verified") === true) {
    return { ...tried, result: "verified" };
  }
  switch (http.attributes.get("http_signatures.failure_reason")) {
    case "noSignature":
      return before ?? { mechanism: tried.mechanism, result: "no_signature" };
    case "keyFetchError": {
      const cause =
        http.attributes.get("http_signatures.key_fetch_status") ??
        http.attributes.get("http_signatures.key_fetch_error");
      return {
        ...tried,
        result: "key_fetch_error",
        detail: `keyFetchError: ${String(cause)}`,
      };
    }
    // Fedify names only a fetch that failed; a key document that holds no key
    // leaves the signature as unchecked.
    default:
      return { ...tried, ...refusal("HTTP signature", measured) };
  }
}

/**
 * Read the `activitypub.activity.received` event of the `activitypub.inbox`
 * span.
 * @returns Whether Fedify went on to handle the activity as a verified one.
 */
const receivedAsVerified = (spans: readonly ObservedSpan[]): boolean =>
  spans
    .find((span) => span.name === "activitypub.inbox")
    ?.events.find((event) => event.name === "activitypub.activity.received")
    ?.attributes["activitypub.activity.verified"] === true;

/**
 * Read the verification out of what Fedify documents it reports: the
 * `activitypub.signature.verification.duration` result of each mechanism it
 * tried, in its order, with the `activitypub.signature.key_fetch.duration` and
 * `activitypub.key.lookup` results of the keys it fetched for each, the
 * `*.verify` spans naming their keys, and the `activitypub.activity.received`
 * event when it went on to handle the activity.  A verdict is of whether a
 * signature or proof verified: proofs that verify without authenticating the
 * activity's actor are verified, whatever Fedify then answered.
 * @returns The verdict of the mechanism that verified, or of the last tried,
 *          with the key fetches of that one verification.
 */
export function reportedVerdict(
  { spans, verifications }: Pick<Report, "spans" | "verifications">,
  carried: Carried,
): Verdict {
  const ld = spans.find((span) => span.name === "ld_signatures.verify");
  const proofs = spans.filter(
    (span) => span.name === "object_integrity_proofs.verify",
  );
  const http = spans.findLast((span) => span.name === "http_signatures.verify");
  const measured = (kind: string) =>
    verifications.filter((measure) => measure.kind === kind);
  const ldMeasured = measured("linked_data").at(-1);
  const httpMeasured = measured("http").at(-1);
  // Fedify reports each proof it tries as a span and as a measurement, in
  // turn, and stops at the first proof that fails, so a failure is the last.
  const proofsMeasured = measured("object_integrity");
  const ldVerdict = (verified: boolean): Verdict => ({
    mechanism: "ld_signature",
    keyIri: reportedIri(ld, "ld_signatures.key_id") ?? carried.ldKeyIri,
    keyFetches: ldMeasured?.keyFetches ?? [],
    ...(verified ? accepted : refusal("Linked Data Signature", ldMeasured)),
  });
  const proofVerdict = (verified: boolean): Verdict => {
    const tried = proofsMeasured.find(
      ({ result }) => (result === "verified") === verified,
    );
    return {
      mechanism: "object_integrity_proof",
      keyIri:
        reportedIri(
          proofs.find((proof) => proof.failed === !verified) ?? proofs[0],
          "object_integrity_proofs.key_id",
        ) ??
        carried.proofMethods.find((method) => method != null) ??
        null,
      keyFetches: tried?.keyFetches ?? [],
      ...(verified ? accepted : refusal("Object Integrity Proof", tried)),
    };
  };
  if (ldMeasured?.result === "verified") return ldVerdict(true);
  if (http?.attributes.get("http_signatures.verified") === true) {
    return httpVerdict(http, null, httpMeasured);
  }
  // Fedify goes on to HTTP signatures unless the proofs authenticate the
  // activity, which takes more than that every one of them verifies.
  if (
    proofsMeasured.length > 0 &&
    proofsMeasured.every(({ result }) => result === "verified")
  ) {
    return http == null
      ? proofVerdict(true)
      : { ...proofVerdict(true), detail: unauthenticated };
  }
  // Fedify accepts an activity naming no actor or attribution vacuously.
  if (receivedAsVerified(spans)) {
    return { mechanism: null, result: "no_signature" };
  }
  // Fedify tries HTTP signatures last, so a signature or proof it reported
  // nothing of was tried only when it went on to them.
  const before =
    proofsMeasured.length > 0 ||
    (http != null && carried.proofMethods.length > 0)
      ? proofVerdict(false)
      : ldMeasured != null || (http != null && carried.ldKeyIri != null)
        ? ldVerdict(false)
        : null;
  if (http != null) return httpVerdict(http, before, httpMeasured);
  return before ?? { mechanism: null, result: "unattempted" };
}

/**
 * Record what Fedify reported of verifying an inbox request, and the key
 * version the verification the verdict is of used, from what `trackRequest()`
 * saw it do.
 * @param json The parsed body, or undefined when it is not JSON.
 * @returns The observation; `unobserved` when observing itself failed.
 */
export async function observeVerification(
  db: Database,
  headers: Headers,
  json: unknown,
  report: Pick<Report, "spans" | "verifications">,
  contextLoader: DocumentLoader,
): Promise<VerificationObservation> {
  const signedKeyIri =
    reportedIri(
      report.spans.findLast((span) => span.name === "http_signatures.verify"),
      "http_signatures.key_id",
    ) ?? declaredKeyId(headers);
  try {
    const verdict = reportedVerdict(report, {
      ldKeyIri: hasLdSignature(json) ? iri(json.signature.creator) : null,
      proofMethods: await proofMethods(detachSignature(json), contextLoader),
    });
    const key =
      verdict.keyIri == null
        ? null
        : await trackedKey(
            verdict.keyFetches ?? [],
            verdict.keyIri,
            verdict.mechanism,
            { contextLoader },
          );
    const version =
      key?.publicKey == null || verdict.keyIri == null
        ? null
        : await observeKeyVersion(db, {
            iri: verdict.keyIri,
            publicKey: await exportJwk(key.publicKey),
          });
    return {
      mechanism: verdict.mechanism,
      result: verdict.result,
      keyId: version?.id ?? null,
      signedKeyIri,
      detail: verdict.detail ?? null,
    };
  } catch (error) {
    logger.error("Could not observe inbox verification: {error}", { error });
    return {
      mechanism: null,
      result: "unobserved",
      keyId: null,
      signedKeyIri,
      detail: `Verification observation failed: ${String(error)}`,
    };
  }
}
