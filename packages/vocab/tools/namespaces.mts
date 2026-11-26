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

/**
 * The namespaces that the known property catalog is checked against and
 * updated from.  To check another namespace, add an entry with the kind that
 * reads what the namespace publishes:
 *
 *  -  `contextNamespace` for a JSON-LD context, which only maps terms to IRIs.
 *  -  `rdfNamespace` for an RDF vocabulary in JSON-LD or Turtle, which can
 *     also declare ranges and functional properties.
 *  -  `anchorNamespace` for an HTML page that documents each term under an
 *     anchor, which the entries' `source` links point to.
 *
 * A namespace with no entry is reported as unchecked.
 */
import { activityStreams } from "./activitystreams.mts";
import {
  type Namespace,
  anchorNamespace,
  contextNamespace,
  rdfNamespace,
} from "./namespace.mts";

export const NAMESPACES: readonly Namespace[] = [
  activityStreams,
  rdfNamespace({
    name: "Linked Data Platform",
    iri: "http://www.w3.org/ns/ldp#",
    url: "http://www.w3.org/ns/ldp",
    format: "turtle",
  }),
  contextNamespace({
    name: "GoToSocial",
    iri: "https://gotosocial.org/ns#",
    url: "https://gotosocial.org/ns",
  }),
  anchorNamespace({
    name: "Misskey",
    iri: "https://misskey-hub.net/ns#",
    url: "https://misskey-hub.net/ns/",
  }),
  contextNamespace({
    name: "Lemmy",
    iri: "https://join-lemmy.org/ns#",
    // The namespace IRI answers 404; this is the context Lemmy sends, which
    // the Lemmy website hosts.
    url: "https://join-lemmy.org/context.json",
  }),
  rdfNamespace({
    name: "vCard",
    iri: "http://www.w3.org/2006/vcard/ns#",
    url: "http://www.w3.org/2006/vcard/ns",
    format: "turtle",
  }),
  rdfNamespace({
    name: "schema.org",
    iri: "http://schema.org/",
    // The namespace IRI serves an HTML page; this is its vocabulary file for
    // the http: IRIs.
    url: "https://schema.org/version/latest/schemaorg-current-http.jsonld",
    format: "json-ld",
  }),
  rdfNamespace({
    name: "Fedibird",
    iri: "http://fedibird.com/ns#",
    url: "http://fedibird.com/ns",
    format: "json-ld",
  }),
  rdfNamespace({
    name: "Dublin Core",
    iri: "http://purl.org/dc/terms/",
    url: "http://purl.org/dc/terms/",
    format: "turtle",
  }),
  rdfNamespace({
    name: "Security Vocabulary",
    iri: "https://w3id.org/security#",
    url: "https://w3id.org/security",
    format: "turtle",
  }),
  contextNamespace({
    name: "FEP-7aa9",
    iri: "https://w3id.org/fep/7aa9#",
    url: "https://w3id.org/fep/7aa9",
  }),
  contextNamespace({
    name: "FEP-c16b",
    iri: "https://w3id.org/fep/c16b#",
    url: "https://w3id.org/fep/c16b",
  }),
  contextNamespace({
    name: "FEP-6757",
    iri: "https://w3id.org/fep/6757#",
    url: "https://w3id.org/fep/6757",
  }),
  contextNamespace({
    name: "FEP-2c59",
    iri: "https://purl.archive.org/socialweb/webfinger#",
    url: "https://purl.archive.org/socialweb/webfinger",
  }),
];
