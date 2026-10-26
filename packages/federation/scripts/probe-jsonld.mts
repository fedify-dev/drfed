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

// Research probe, not a validator or a conformance test. Run from the root:
// mise exec -- node packages/federation/scripts/probe-jsonld.mts
// oxlint-disable no-await-in-loop

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import process from "node:process";

import * as vocab from "@fedify/vocab";
import { type DocumentLoader, preloadedContexts } from "@fedify/vocab-runtime";

const context = "https://www.w3.org/ns/activitystreams";
const actor = "https://example.com/users/alice";
const object = "https://remote.example/posts/42";
const like = { "@context": context, type: "Like", actor, object };

const cases: readonly { name: string; document: unknown }[] = [
  { name: "Valid Like with IRI references", document: like },
  {
    name: "Valid Create with embedded Note",
    document: {
      "@context": context,
      type: "Create",
      actor,
      object: { type: "Note", content: "Hello" },
    },
  },
  { name: "Invalid numeric object", document: { ...like, object: 123 } },
  { name: "Invalid numeric actor", document: { ...like, actor: 123 } },
  { name: "Missing actor", document: { ...like, actor: undefined } },
  {
    name: "Invalid publication timestamp",
    document: { ...like, published: "not-a-date" },
  },
  {
    name: "Undo with invalid nested Like object",
    document: {
      ...like,
      type: "Undo",
      object: { type: "Like", actor, object: 123 },
    },
  },
  {
    name: "Accept with invalid nested list entry",
    document: {
      ...like,
      type: "Accept",
      object: [{ type: "Follow", actor: 123, object: actor }],
    },
  },
  {
    name: "Arrive without object",
    document: { "@context": context, type: "Arrive", actor },
  },
  {
    name: "Unknown extension field with inline context",
    document: {
      ...like,
      "@context": [context, { testField: "https://example.com/ns#testField" }],
      testField: "keep me",
    },
  },
  {
    name: "Unknown extension type",
    document: { ...like, type: "https://example.com/ns#CustomActivity" },
  },
  {
    name: "Unknown remote context (blocked, not malformed structure)",
    document: {
      ...like,
      "@context": [context, "https://remote.example/context"],
    },
  },
  { name: "Invalid root", document: 123 },
];

function describeError(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error);
  return { name: error.name, message: error.message };
}

async function probe(name: string, input: unknown): Promise<void> {
  // Model what JSON parsing actually supplies (e.g., no undefined properties).
  const document: unknown = JSON.parse(JSON.stringify(input));
  const original = structuredClone(document);
  const contextLoads: string[] = [];
  const resourceLoads: string[] = [];
  const contextLoader: DocumentLoader = (url) => {
    contextLoads.push(url);
    if (!Object.hasOwn(preloadedContexts, url)) {
      return Promise.reject(new Error(`Offline context unavailable: ${url}`));
    }
    return Promise.resolve({
      contextUrl: null,
      documentUrl: url,
      document: structuredClone(preloadedContexts[url]),
    });
  };
  const documentLoader: DocumentLoader = (url) => {
    resourceLoads.push(url);
    return Promise.reject(new Error(`Remote resource lookup blocked: ${url}`));
  };
  const options = { contextLoader, documentLoader };
  const result: Record<string, unknown> = { name, input: document };

  try {
    const parsed = await vocab.Object.fromJsonLd(document, options);
    result.parse = "accepted";
    result.resourceLoadsAfterParse = [...resourceLoads];
    result.parsedClass = parsed.constructor.name;
    result.parsedId = parsed.id?.href ?? null;
    result.parsedPublished = parsed.published?.toString() ?? null;
    if (parsed instanceof vocab.Activity) {
      result.parsedActorIds = parsed.actorIds.map((value) => value.href);
      result.parsedObjectIds = parsed.objectIds.map((value) => value.href);
    }
    result.defaultOutput = await parsed.toJsonLd({ contextLoader });
    // Re-serialization via compaction can differ from the cached default output.
    try {
      result.compactedOutput = await parsed.toJsonLd({
        format: "compact",
        context,
        contextLoader,
      });
    } catch (error) {
      result.compactionError = describeError(error);
    }
    // Embedded values can be decoded lazily. Capture failures at this stage too.
    if (parsed instanceof vocab.Activity) {
      try {
        const embedded = await parsed.getObject(options);
        result.objectAccessor = {
          parsedClass: embedded?.constructor.name ?? null,
          actorIds:
            embedded instanceof vocab.Activity
              ? embedded.actorIds.map((value) => value.href)
              : null,
          objectIds:
            embedded instanceof vocab.Activity
              ? embedded.objectIds.map((value) => value.href)
              : null,
        };
      } catch (error) {
        result.objectAccessorError = describeError(error);
      }
    }
  } catch (error) {
    result.parse = "rejected";
    result.parseError = describeError(error);
  }
  assert.deepEqual(
    document,
    original,
    "Parsing must leave the input unchanged",
  );
  result.contextLoads = contextLoads;
  result.blockedResourceLoads = resourceLoads;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const require = createRequire(import.meta.url);
const { version } = require("@fedify/vocab/package.json") as {
  version: string;
};
process.stdout.write(
  `Fedify vocabulary ${version}; all network access blocked\n`,
);

const originalFetch = globalThis.fetch;
let fetchAttempts = 0;
globalThis.fetch = () => {
  fetchAttempts += 1;
  return Promise.reject(new Error("Network fetch blocked by JSON-LD probe"));
};
try {
  for (const fixture of cases) {
    await probe(fixture.name, fixture.document);
  }
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(fetchAttempts, 0, "Custom loaders must prevent network fetches");
process.stdout.write(
  `Completed ${cases.length} probes; fetch attempts: ${fetchAttempts}\n`,
);
