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

import { activityStreams } from "./activitystreams.mts";
import type { CatalogEntry } from "./namespace.mts";

const AS = "https://www.w3.org/ns/activitystreams#";
const LDP = "http://www.w3.org/ns/ldp#";
const VOCABULARY = "https://www.w3.org/TR/activitystreams-vocabulary/";
const ACTIVITYPUB = "https://www.w3.org/TR/activitypub/";

const DOCUMENTS = new Map([
  [
    "context",
    JSON.stringify({
      "@context": {
        as: AS,
        ldp: LDP,
        Object: "as:Object",
        Link: "as:Link",
        xsd: "http://www.w3.org/2001/XMLSchema#",
        items: "as:items",
        units: "as:units",
        mediaType: "as:mediaType",
        oddity: "as:oddity",
        actor: { "@id": "as:actor", "@type": "@id" },
        name: "as:name",
        inbox: { "@id": "ldp:inbox", "@type": "@id" },
      },
    }),
  ],
  [
    "namespace",
    `<section id="property-definitions">
      <a id="actor" href="${VOCABULARY}#dfn-actor">actor</a>
      <a id="name" href="${VOCABULARY}#dfn-name">name</a>
      <a id="inbox" href="${ACTIVITYPUB}#inbox">inbox</a>
      <a id="items" href="${VOCABULARY}#dfn-items">items</a>
      <a id="units" href="${VOCABULARY}#dfn-units">units</a>
      <a id="mediaType" href="${VOCABULARY}#dfn-mediatype">mediaType</a>
      <a id="oddity" href="${VOCABULARY}#dfn-oddity">oddity</a>
    </section>`,
  ],
  [
    "vocabulary",
    `<table>
      <tr><td><dfn id="dfn-actor">actor</dfn></td>
        <td>URI:</td><td>${AS}actor</td></tr>
      <tr><td>Notes:</td><td>Describes one or more entities.</td></tr>
      <tr><td>Range:</td><td>Object | Link</td></tr>
    </table>
    <table>
      <tr><td><dfn id="dfn-name">name</dfn></td>
        <td>URI:</td><td>${AS}name</td></tr>
      <tr><td>Range:</td><td>xsd:string</td></tr>
    </table>
    ${[
      ["items", "Object | Link | Ordered List of [ Object | Link ]"],
      ["units", '"cm" | " feet" | xsd:anyURI'],
      ["mediatype", "MIME Media Type"],
      ["oddity", "anyURI"],
    ]
      .map(
        ([anchor, range]) => `<table>
      <tr><td><dfn id="dfn-${anchor}">${anchor}</dfn></td>
        <td>URI:</td><td>${AS}${anchor === "mediatype" ? "mediaType" : anchor}</td></tr>
      <tr><td>Notes:</td><td>Notes.</td></tr>
      <tr><td>Range:</td><td>${range}</td></tr>
    </table>`,
      )
      .join("\n")}`,
  ],
  [
    "activityPub",
    `<dl>
      <dt id="inbox">inbox</dt><dd>A reference to an OrderedCollection.</dd>
      <dt id="outbox">outbox</dt><dd>An OrderedCollection.</dd>
    </dl>`,
  ],
]);

const entryAt = (source: string): CatalogEntry => ({
  description: { en: "Old." },
  source,
});

const findingsOf = async (entries: Record<string, CatalogEntry>) =>
  await activityStreams.find(new Map(Object.entries(entries)), DOCUMENTS);

describe("activityStreams", () => {
  it("covers the entries whose source is either specification", () => {
    assert.equal(
      activityStreams.covers(`${LDP}inbox`, entryAt(`${ACTIVITYPUB}#inbox`)),
      true,
    );
    assert.equal(
      activityStreams.covers(`${AS}sensitive`, entryAt("https://example.org/")),
      false,
    );
  });

  it("gives the values of an Activity Vocabulary definition", async () => {
    const findings = await findingsOf({
      [`${AS}actor`]: entryAt(`${VOCABULARY}#old-anchor`),
    });
    assert.deepEqual(findings.get(`${AS}actor`), {
      origin: "the Activity Vocabulary",
      expected: {
        description: "Describes one or more entities.",
        range: [`${AS}Object`, `${AS}Link`],
        multiple: true,
        source: `${VOCABULARY}#dfn-actor`,
      },
      problems: [],
    });
  });

  it("leaves the description of a definition without notes unchecked", async () => {
    const findings = await findingsOf({
      [`${AS}name`]: entryAt(`${VOCABULARY}#dfn-name`),
    });
    const finding = findings.get(`${AS}name`);
    assert.equal(finding?.expected.description, undefined);
    assert.deepEqual(finding?.problems, [
      "the Activity Vocabulary definition at #dfn-name has no notes, so description is not checked",
    ]);
  });

  it("gives the description of an ActivityPub definition", async () => {
    const findings = await findingsOf({
      [`${LDP}inbox`]: entryAt(`${ACTIVITYPUB}#inbox`),
    });
    assert.deepEqual(findings.get(`${LDP}inbox`), {
      origin: "ActivityPub",
      expected: { description: "A reference to an OrderedCollection." },
      problems: [],
    });
  });

  it("reports an ActivityPub source without a fragment", async () => {
    const findings = await findingsOf({
      [`${LDP}inbox`]: entryAt(ACTIVITYPUB),
    });
    assert.deepEqual(findings.get(`${LDP}inbox`)?.problems, [
      "source has no fragment",
    ]);
  });

  it("reports a source that points to another term", async () => {
    const findings = await findingsOf({
      [`${LDP}inbox`]: entryAt(`${ACTIVITYPUB}#outbox`),
    });
    assert.deepEqual(findings.get(`${LDP}inbox`), {
      origin: "ActivityPub",
      expected: {},
      problems: [
        "source points to the definition of outbox, not inbox, so description is not checked",
      ],
    });
  });

  it("reads an ordered list of types as those types", async () => {
    const findings = await findingsOf({
      [`${AS}items`]: entryAt(`${VOCABULARY}#dfn-items`),
    });
    assert.deepEqual(findings.get(`${AS}items`)?.expected.range, [
      `${AS}Object`,
      `${AS}Link`,
    ]);
    assert.deepEqual(findings.get(`${AS}items`)?.problems, []);
  });

  it("gives an empty range when every range is prose", async () => {
    const findings = await findingsOf({
      [`${AS}mediaType`]: entryAt(`${VOCABULARY}#dfn-mediatype`),
    });
    assert.deepEqual(findings.get(`${AS}mediaType`)?.expected.range, []);
  });

  it("gives no range when part of it has no IRI", async () => {
    const findings = await findingsOf({
      [`${AS}units`]: entryAt(`${VOCABULARY}#dfn-units`),
      [`${AS}oddity`]: entryAt(`${VOCABULARY}#dfn-oddity`),
    });
    assert.equal(
      "range" in (findings.get(`${AS}units`)?.expected ?? {}),
      false,
    );
    assert.deepEqual(findings.get(`${AS}units`)?.problems, [
      'the Activity Vocabulary range has "\\"cm\\"", "\\" feet\\"", which the namespace context gives no IRI for, so range is not checked',
    ]);
    assert.equal(
      "range" in (findings.get(`${AS}oddity`)?.expected ?? {}),
      false,
    );
    assert.equal(findings.get(`${AS}oddity`)?.problems.length, 1);
  });

  it("reports an IRI that is not a property of the namespace", async () => {
    const findings = await findingsOf({
      [`${AS}missing`]: entryAt(`${VOCABULARY}#dfn-missing`),
    });
    assert.deepEqual(findings.get(`${AS}missing`)?.problems, [
      "the Activity Streams namespace does not define it as a property",
    ]);
  });
});
