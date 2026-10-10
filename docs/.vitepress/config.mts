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

import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "en-US",
  title: "DrFed",
  description:
    "Documentation for DrFed, a web-based platform for developing and debugging ActivityPub apps.",
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/icon.svg" }]],
  themeConfig: {
    logo: { src: "/icon.svg", alt: "" },
    nav: [
      { text: "Installation", link: "/installation/manual-installation" },
      { text: "Manual", link: "/manual/self-hosting" },
      { text: "CLI reference", link: "/reference/cli" },
    ],
    sidebar: [
      {
        text: "Installation",
        items: [
          {
            text: "Manual installation",
            link: "/installation/manual-installation",
          },
        ],
      },
      {
        text: "Manual",
        items: [{ text: "Self-hosting", link: "/manual/self-hosting" }],
      },
      {
        text: "Reference",
        items: [{ text: "CLI", link: "/reference/cli" }],
      },
    ],
    search: { provider: "local" },
    socialLinks: [
      { icon: "github", link: "https://github.com/fedify-dev/drfed" },
    ],
    editLink: {
      pattern: "https://github.com/fedify-dev/drfed/edit/main/docs/:path",
    },
    footer: {
      message: "Licensed under the GNU AGPL v3 or later.",
      copyright: "Copyright © 2026 DrFed team",
    },
  },
});
