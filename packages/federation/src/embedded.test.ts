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
import { describe, it } from "node:test";

import { embeddedObject } from "@drfed/federation/embedded";
import { type DocumentLoader, preloadedContexts } from "@fedify/vocab-runtime";

const AS = "https://www.w3.org/ns/activitystreams";
const REMOTE = "https://remote.example/context";

const note = { type: "Note", id: "https://remote.example/notes/1" };
const create = {
  "@context": [AS, REMOTE],
  type: "Create",
  id: "https://remote.example/activities/1",
  object: note,
};

function loader(remote: () => Promise<unknown>, calls: string[] = []) {
  const load: DocumentLoader = async (url) => {
    calls.push(url);
    const document = Object.hasOwn(preloadedContexts, url)
      ? preloadedContexts[url]
      : await remote();
    return { contextUrl: null, documentUrl: url, document };
  };
  return load;
}

describe("embeddedObject()", () => {
  it("finds the object and its place", async () => {
    const found = await embeddedObject(
      create,
      loader(() => Promise.resolve({ "@context": {} })),
    );
    assert.deepEqual(found, { document: note, path: ["object"] });
  });

  it("reports why a context failed instead of a missing object", async () => {
    const calls: string[] = [];
    const found = await embeddedObject(
      create,
      loader(() => Promise.reject(new Error("timed out")), calls),
    );
    assert.ok(found !== undefined && "failure" in found);
    assert.match(found.failure, /Caused by Error: timed out$/u);
    // The first failure stops the probes, which would all fail alike.
    assert.equal(calls.filter((url) => url === REMOTE).length, 1);
  });

  it("finds nothing in an activity without an embedded object", async () => {
    assert.equal(
      await embeddedObject(
        { ...create, object: "https://remote.example/notes/1" },
        loader(() => Promise.resolve({ "@context": {} })),
      ),
      undefined,
    );
  });
});
