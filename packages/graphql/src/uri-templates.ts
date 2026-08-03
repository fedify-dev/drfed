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

import { Template } from "@fedify/uri-template";

export const avatarTemplate = new Template(
  "https://{host}/users/{id}/avatar/{avatar}",
);
export const featuredTemplate = new Template(
  "https://{host}/users/{id}/featured",
);
export const followeesTemplate = new Template(
  "https://{host}/users/{id}/followees",
);
export const followersTemplate = new Template(
  "https://{host}/users/{id}/followers",
);
export const handleTemplate = new Template("@{username}@{host}");
export const headerTemplate = new Template(
  "https://{host}/users/{id}/header/{header}",
);
export const inboxTemplate = new Template("https://{host}/users/{id}/inbox");
export const iriTemplate = new Template("https://{host}/users/{id}");
export const outboxTemplate = new Template("https://{host}/users/{id}/outbox");
export const profileTemplate = new Template("https://{host}/@{username}");

const templates = {
  avatar: avatarTemplate,
  featured: featuredTemplate,
  followees: followeesTemplate,
  followers: followersTemplate,
  handle: handleTemplate,
  header: headerTemplate,
  inbox: inboxTemplate,
  iri: iriTemplate,
  outbox: outboxTemplate,
  profile: profileTemplate,
};
export default templates;
