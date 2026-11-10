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

import { interpretDocument } from "@drfed/federation/document";
import { describe, it } from "@logtape/testing-node/autoload";

const AS = "https://www.w3.org/ns/activitystreams";

describe("interpretDocument()", () => {
  it("reads relations and recipients of every document by meaning", () => {
    const document = {
      "@context": [
        AS,
        {
          about: { "@id": "as:object", "@type": "@id" },
          ex: "https://ext.example/ns#",
        },
      ],
      type: "Undo",
      id: "https://example.com/undo",
      actor: "https://example.com/alice",
      to: [null, "as:Public", { type: "Person" }],
      about: [
        {
          type: "Like",
          actor: "https://example.com/alice",
          object: { type: "Link", href: "https://example.com/note" },
          "ex:note": "kept",
        },
        "https://example.com/likes/2",
      ],
    };
    const nodes = interpretDocument(document);
    assert.ok(nodes != null);
    const [root, like, link] = nodes;
    assert.ok(root != null && like != null && link != null);
    assert.equal(root.iri, "https://example.com/undo");
    assert.equal(root.value, document);
    assert.deepEqual(
      root.relations.map(({ property, path, representation, iri, node }) => [
        property,
        path,
        representation,
        iri,
        node?.type ?? null,
      ]),
      [
        ["actor", ["actor"], "reference", "https://example.com/alice", null],
        ["object", ["about", 0], "embedded", null, `${AS}#Like`],
        [
          "object",
          ["about", 1],
          "reference",
          "https://example.com/likes/2",
          null,
        ],
      ],
    );
    // A null names nothing; an anonymous recipient keeps its position.
    assert.deepEqual(
      root.addressing.map(({ property, position, representation, iri }) => [
        property,
        position,
        representation,
        iri,
      ]),
      [
        ["to", 1, "reference", `${AS}#Public`],
        ["to", 2, "embedded", null],
      ],
    );
    assert.equal(like.property, "object");
    assert.deepEqual(like.extensions, [{ key: "ex:note", value: "kept" }]);
    assert.deepEqual(
      like.relations.map(({ property, representation, iri }) => [
        property,
        representation,
        iri,
      ]),
      [
        ["actor", "reference", "https://example.com/alice"],
        ["object", "link", "https://example.com/note"],
      ],
    );
    assert.equal(like.relations[1]?.node, link);
    assert.equal(link.iri, "https://example.com/note");
  });

  it("returns null for a document the validator does not read", () => {
    assert.equal(
      interpretDocument({ "@context": AS, type: "Note", tag: [] }),
      null,
    );
    assert.equal(interpretDocument(null), null);
  });
});
