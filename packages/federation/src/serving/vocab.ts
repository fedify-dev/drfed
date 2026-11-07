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

// oxlint-disable max-classes-per-file -- One subclass per vocabulary class Fedify and the dispatchers check with instanceof.

import { Object as APObject, Activity, Create } from "@fedify/vocab";

import type { JsonObject } from "../local-write/types.ts";
import { type ServedDocument, createType } from "./document.ts";

/** The options of Fedify's `toJsonLd()`. */
type JsonLdOptions = NonNullable<Parameters<APObject["toJsonLd"]>[0]>;

/**
 * Serializes a stored document as a vocabulary object's JSON-LD.  Fedify
 * serves objects and collection items in the default form, which is the
 * document itself; an explicit form is Fedify's own reading of the
 * document, which fails for values Fedify cannot read.
 * @returns The JSON-LD.
 */
async function documentJsonLd(
  document: JsonObject,
  options: JsonLdOptions,
): Promise<unknown> {
  if (options.format == null) return structuredClone(document);
  const parsed = await APObject.fromJsonLd(
    document,
    options.contextLoader == null
      ? {}
      : { contextLoader: options.contextLoader },
  );
  return await parsed.toJsonLd(options);
}

class DocumentObject extends APObject {
  readonly #document: JsonObject;

  constructor(id: URL, document: JsonObject) {
    super({ id });
    this.#document = document;
  }

  override async toJsonLd(options: JsonLdOptions = {}): Promise<unknown> {
    return await documentJsonLd(this.#document, options);
  }
}

class DocumentActivity extends Activity {
  readonly #document: JsonObject;

  constructor(id: URL, document: JsonObject) {
    super({ id });
    this.#document = document;
  }

  override async toJsonLd(options: JsonLdOptions = {}): Promise<unknown> {
    return await documentJsonLd(this.#document, options);
  }
}

class DocumentCreate extends Create {
  readonly #document: JsonObject;

  constructor(id: URL, document: JsonObject) {
    super({ id });
    this.#document = document;
  }

  override async toJsonLd(options: JsonLdOptions = {}): Promise<unknown> {
    return await documentJsonLd(this.#document, options);
  }
}

function servedId(served: ServedDocument): URL {
  if (served.id == null) throw new TypeError("A served document needs an id.");
  return new URL(served.id);
}

/**
 * Wraps a served activity document in a vocabulary object that Fedify serves
 * as the document itself, without parsing it, so that a document with values
 * Fedify cannot read, such as a `Link` in `audience` or `object`, is served
 * as saved.  Its only property is its `id`; it is a `Create` for a `Create`.
 * @param served A served document, as `serveDocument()` makes it.
 * @returns The vocabulary object.
 */
export function documentActivity(served: ServedDocument): Activity {
  return served.type === createType
    ? new DocumentCreate(servedId(served), served.document)
    : new DocumentActivity(servedId(served), served.document);
}

/**
 * Wraps a served object document in a vocabulary object that Fedify serves
 * as the document itself.  See {@link documentActivity}.
 * @param served A served document, as `serveDocument()` makes it.
 * @returns The vocabulary object.
 */
export function documentObject(served: ServedDocument): APObject {
  return new DocumentObject(servedId(served), served.document);
}
