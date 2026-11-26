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
 * A namespace with no entry is reported as unchecked.  The comment after the
 * list records why each such namespace cannot be checked.
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

/*
 * Namespaces that cannot be checked, as surveyed in November 2026.  None of
 * them publishes a document the kinds above read, so the check reports their
 * entries as unchecked.  When one starts publishing a definition, add it to
 * the list above and remove it here.
 *
 * Deliberately not dereferenceable:
 *
 *  -  `http://joinmastodon.org/ns#` (Mastodon): the IRI has never served a
 *     document, and Mastodon inlines its terms in every `@context`: “It's a
 *     "fake" namespace, that's why we inline it in the JSON-LD.”
 *     <https://github.com/mastodon/joinmastodon/issues/148>
 *  -  `http://schema.org#` (Mastodon's profile field `value`): a misspelling
 *     of `http://schema.org/` that Mastodon documents as incorrect and keeps
 *     for compatibility.  schema.org defines `http://schema.org/value`, not
 *     this IRI.  <https://github.com/mastodon/mastodon/issues/18361>
 *  -  `http://ostatus.org#` (Mastodon): an identifier on a domain that has
 *     lapsed and now redirects to unrelated sites.  Mastodon holds that such
 *     an identifier need not resolve and cannot change without breaking
 *     compatibility.  <https://github.com/mastodon/mastodon/issues/37869>
 *  -  `https://joinpeertube.org/ns#` (PeerTube): redirects on purpose to
 *     <https://docs.joinpeertube.org/api/activitypub>, a human-readable page
 *     with anchors only per object type, which no longer mentions
 *     `commentsEnabled`.  <https://github.com/Chocobozzz/PeerTube/issues/1424>
 *
 * Planned or once published, now missing:
 *
 *  -  `https://joinsharkey.org/ns#` (Sharkey): served an HTML page of its
 *     terms in 2023, which was lost when the website was rebuilt; the IRI now
 *     answers 404.  The documentation of the extensions is still an open
 *     issue.  <https://activitypub.software/TransFem-org/Documentation/-/work_items/23>
 *  -  `http://litepub.social/ns#` (Pleroma, Akkoma): meant to be published by
 *     the LitePub project, which stalled in 2019 first; the IRI answers 404.
 *     Pleroma and Akkoma define the terms in a context each instance serves,
 *     not in a document of the namespace.
 *     <https://git.pleroma.social/pleroma/pleroma/issues/369>
 *  -  `http://pixelfed.org/ns#` (Pixelfed): introduced as not resolving yet,
 *     and the website answers every path, this one too, with the same page
 *     that needs JavaScript.  <https://github.com/pixelfed/pixelfed/pull/3464>
 *  -  `https://w3id.org/fep/044f#`, `https://w3id.org/fep/5837#`, and
 *     `https://w3id.org/fep/070c#`: unlike FEP-7aa9, FEP-c16b, and FEP-6757,
 *     these FEPs ship no *fep-<id>.jsonld*, so the w3id.org redirect answers
 *     404.  Only the draft FEP-888d requires the file; the FEP process does
 *     not.  <https://github.com/perma-id/w3id.org/blob/master/ids/fep/.htaccess>
 *
 * Never published, with no statement either way:
 *
 *  -  `https://joinloops.org/ns#` (Loops) and `http://smithereen.software/ns#`
 *     (Smithereen): both IRIs answer 404, no archived copy shows a document,
 *     and both implementations inline their terms.
 *
 * The entries under `https://www.w3.org/ns/activitystreams#` that other
 * vocabularies coined, such as `sensitive`, `manuallyApprovesFollowers`,
 * `movedTo`, and `quoteUrl`, are not defined by the Activity Streams
 * namespace either.  `alsoKnownAs` is, but its entry follows Controlled
 * Identifiers rather than the namespace.
 */
