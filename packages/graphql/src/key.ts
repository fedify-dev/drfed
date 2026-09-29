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

import builder, { type DrFedObjectRef } from "./builder.ts";

const KeyRef = builder.drizzleNode("keys", {
  name: "Key",
  authScopes: { authenticated: true },
  runScopesOnType: true,
  id: { column: (key) => key.id },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    iri: t.expose("iri", { type: "URL" }),
    created: t.expose("created", { type: "DateTime" }),
    versions: t.relation("versions", {
      query: { orderBy: { firstSeen: "asc", id: "asc" } },
    }),
  }),
});
export const Key: DrFedObjectRef = KeyRef;
const observationDescription =
  "DrFed observation time, not the remote key rotation time; " +
  "does not imply continuous use between observations.";
const KeyVersionRef = builder.drizzleNode("keyVersions", {
  name: "KeyVersion",
  authScopes: { authenticated: true },
  runScopesOnType: true,
  id: { column: (version) => version.id },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    key: t.relation("key"),
    publicKey: t.expose("publicKey", { type: "JSON" }),
    fingerprint: t.exposeString("fingerprint"),
    firstSeen: t.expose("firstSeen", {
      type: "DateTime",
      description: `First ${observationDescription}`,
    }),
    lastSeen: t.expose("lastSeen", {
      type: "DateTime",
      description: `Last ${observationDescription}`,
    }),
  }),
});
export const KeyVersion: DrFedObjectRef = KeyVersionRef;
