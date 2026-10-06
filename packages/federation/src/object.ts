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

import type {
  ActivityPubObject,
  Actor,
  Addressing,
  ObjectType,
  Resource,
  StoredActivity,
} from "@drfed/models/schema";
import type { Context } from "@fedify/fedify";
import {
  Object as APObject,
  Article,
  Create,
  LanguageString,
  Note,
} from "@fedify/vocab";

type ObjectProps = ConstructorParameters<typeof Note>[0];
const objectConstructors: Record<ObjectType, (props: ObjectProps) => APObject> =
  {
    Article: (props) => new Article(props),
    Note: (props) => new Note(props),
  };

type StoredAddressing = Addressing & { targetResource: Resource };
export const objectSelection = {
  resource: true,
  actor: { with: { resource: true } },
  addressing: { with: { targetResource: true }, orderBy: { position: "asc" } },
} as const;
export const activitySelection = {
  resource: true,
  actor: { with: { resource: true } },
  object: true,
  addressing: { with: { targetResource: true }, orderBy: { position: "asc" } },
} as const;

/**
 * A stored object loaded with {@link objectSelection}, as {@link toObject}
 * serializes it.
 */
export type StoredObject = ActivityPubObject & {
  resource: Resource;
  actor: Actor & { resource: Resource };
  addressing: StoredAddressing[];
};

/**
 * A stored `Create` activity loaded with {@link activitySelection}, as
 * {@link toCreate} serializes it.
 */
export type StoredCreate = StoredActivity & {
  resource: Resource;
  actor: Actor & { resource: Resource };
  object: Resource | null;
  addressing: StoredAddressing[];
};

function recipients(rows: readonly StoredAddressing[]): {
  tos: URL[];
  ccs: URL[];
  audiences: URL[];
} {
  const values = (property: string): URL[] =>
    rows
      .filter((entry) => entry.property === property)
      .toSorted((left, right) => left.position - right.position)
      .map((entry) => new URL(entry.targetResource.iri));
  return {
    tos: values("to"),
    ccs: values("cc"),
    audiences: values("audience"),
  };
}

/**
 * Serializes stored object addressing; blind recipients stay in the database.
 * @returns The vocabulary object without blind recipients.
 */
export function toObject(
  _ctx: Context<unknown>,
  object: StoredObject,
): APObject {
  return objectConstructors[object.type]({
    id: new URL(object.resource.iri),
    attribution: new URL(object.actor.resource.iri),
    contents: [
      object.contentHtml,
      ...(object.language == null
        ? []
        : [new LanguageString(object.contentHtml, object.language)]),
    ],
    name: object.name,
    summary: object.summary,
    sensitive: object.sensitive,
    published: object.published,
    updated: object.updated,
    url: object.url == null ? null : new URL(object.url),
    ...recipients(object.addressing),
  });
}

/**
 * Serializes a persisted Create activity, retaining its own IRI and addressing.
 * @returns The vocabulary activity without blind recipients.
 */
export function toCreate(
  _ctx: Context<unknown>,
  activity: StoredCreate,
): Create {
  return new Create({
    id: new URL(activity.resource.iri),
    actor: new URL(activity.actor.resource.iri),
    ...recipients(activity.addressing),
    object: activity.object == null ? null : new URL(activity.object.iri),
    published: activity.published,
  });
}
