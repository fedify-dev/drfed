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

import type { JsonObject } from "@drfed/federation/local-write";
import { PUBLIC_IRI } from "@drfed/models/resource";

/**
 * `Activity`, `IntransitiveActivity` and every activity type the
 * ActivityStreams vocabulary names.  The same list as `activityTypes` in
 * *packages/models/src/resource-revision.test.ts*, which is not built and so
 * cannot be imported here; change the two together.
 */
export const activityTypes = [
  "Activity",
  "IntransitiveActivity",
  "Accept",
  "Add",
  "Announce",
  "Arrive",
  "Block",
  "Create",
  "Delete",
  "Dislike",
  "Flag",
  "Follow",
  "Ignore",
  "Invite",
  "Join",
  "Leave",
  "Like",
  "Listen",
  "Move",
  "Offer",
  "Question",
  "Read",
  "Reject",
  "Remove",
  "TentativeAccept",
  "TentativeReject",
  "Travel",
  "Undo",
  "Update",
  "View",
] as const;

export type ActivityType = (typeof activityTypes)[number];

/** The blind recipient every fixture is addressed to. */
const blindRecipient = "https://remote.example/users/blind";

/**
 * The extension value every fixture carries: an array whose order and
 * repeated values matter, `false` and `null`.  `-0` is left out, since a
 * JSON round trip makes it `0`.
 */
export const extensionValue: JsonObject = {
  ordered: [2, 1, 2],
  enabled: false,
  empty: null,
};

/**
 * Makes the document saved for an activity type: Public, with a blind
 * recipient and an extension property, and nothing a type requires, since
 * the validator requires nothing of any of these types.
 * @param type The activity type.
 * @returns A new document.
 */
export const typeDocument = (type: ActivityType): JsonObject => ({
  "@context": [
    "https://www.w3.org/ns/activitystreams",
    { test: "https://example.test/vocab#" },
  ],
  type,
  to: [PUBLIC_IRI],
  bto: [blindRecipient],
  "test:extension": structuredClone(extensionValue),
});
