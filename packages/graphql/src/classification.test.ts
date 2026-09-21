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

import {
  classifyMastodon,
  classifyMisskey,
} from "@drfed/graphql/classification";
import { PUBLIC_IRI } from "@drfed/models/resource";

const author = {
  iri: "https://example.com/alice",
  followersIri: "https://example.com/alice/followers",
};
describe("expected classifications", () => {
  for (const publicIri of [PUBLIC_IRI, "as:Public", "Public"]) {
    it(`recognizes ${publicIri} in both implementations`, () => {
      assert.equal(
        classifyMastodon({ to: [publicIri] }, null, author).classification,
        "public",
      );
      assert.equal(
        classifyMisskey({ to: [publicIri] }, null, author).classification,
        "public",
      );
      assert.equal(
        classifyMastodon({ cc: [publicIri] }, null, author).classification,
        "unlisted",
      );
      assert.equal(
        classifyMisskey({ cc: [publicIri] }, null, author).classification,
        "home",
      );
    });
  }
  it("distinguishes followers only in cc", () => {
    const addressing = { cc: [author.followersIri] };
    assert.equal(
      classifyMastodon(addressing, null, author).classification,
      "direct",
    );
    assert.equal(
      classifyMisskey(addressing, null, author).classification,
      "followers",
    );
    assert.equal(
      classifyMastodon({ to: [author.followersIri] }, null, author)
        .classification,
      "private",
    );
  });
  it("falls back per missing object property only in Mastodon", () => {
    const activity = { to: [PUBLIC_IRI], cc: [PUBLIC_IRI] };
    assert.equal(
      classifyMastodon({}, activity, author).classification,
      "public",
    );
    assert.equal(
      classifyMastodon({ to: [], cc: [] }, activity, author).classification,
      "direct",
    );
    assert.equal(
      classifyMastodon({ to: [] }, activity, author).classification,
      "unlisted",
    );
    assert.equal(
      classifyMisskey({}, activity, author).classification,
      "specified",
    );
  });
  it("uses Misskey's inferred followers path only when the author has none", () => {
    const unknown = { iri: author.iri, followersIri: null };
    assert.equal(
      classifyMastodon({ to: [author.followersIri] }, null, unknown)
        .classification,
      "direct",
    );
    assert.equal(
      classifyMisskey({ to: [author.followersIri] }, null, unknown)
        .classification,
      "followers",
    );
  });
});
