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

import { forEngine } from "../../scripts/images/engines.mts";

// A link to the other deployment (the release site from canary and the other
// way around), set at build time.  Neither variable set means no extra link;
// setting only one of them is a misconfigured deployment and fails the build.
// oxlint-disable-next-line node/no-process-env
const { EXTRA_NAV_TEXT, EXTRA_NAV_LINK } = process.env;
if (Boolean(EXTRA_NAV_TEXT) !== Boolean(EXTRA_NAV_LINK)) {
  throw new Error(
    "EXTRA_NAV_TEXT and EXTRA_NAV_LINK must be set together or not at all; " +
      `got EXTRA_NAV_TEXT=${JSON.stringify(EXTRA_NAV_TEXT ?? "")} and ` +
      `EXTRA_NAV_LINK=${JSON.stringify(EXTRA_NAV_LINK ?? "")}.`,
  );
}
const extraNav =
  EXTRA_NAV_TEXT && EXTRA_NAV_LINK
    ? [{ text: EXTRA_NAV_TEXT, link: EXTRA_NAV_LINK }]
    : [];

// The image tag that Compose snippets and examples name.  CI builds that
// deploy pass the exact version the same workflow run published, so every
// example names an image that exists; other builds keep the checked-in tag.
// oxlint-disable-next-line node/no-process-env
const { DRFED_IMAGE_VERSION } = process.env;
if (
  DRFED_IMAGE_VERSION !== undefined &&
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(DRFED_IMAGE_VERSION)
) {
  throw new Error(
    `DRFED_IMAGE_VERSION must be a published version; got ${JSON.stringify(DRFED_IMAGE_VERSION)}.`,
  );
}
const imageReference = /\bghcr\.io\/fedify-dev\/drfed:\d[0-9A-Za-z.-]*/gu;
function publishedImage(text: string): string {
  return DRFED_IMAGE_VERSION === undefined
    ? text
    : text.replaceAll(
        imageReference,
        `ghcr.io/fedify-dev/drfed:${DRFED_IMAGE_VERSION}`,
      );
}

// Star-orbit symbol from https://github.com/hackers-pub/visual-identity
// (exports/starorbit-transparent-17x12.svg), © 2025 Bak Eunji,
// CC BY-SA 4.0 <https://creativecommons.org/licenses/by-sa/4.0/>.
// Modified: recolored to currentColor and stripped of IDs and clip paths.
const HACKERS_PUB_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="17.995798" height="12.67316" viewBox="0 0 17.995798 12.67316"><title>hackers.pub</title><desc>Star-orbit symbol by Bak Eunji (hackers-pub/visual-identity), CC BY-SA 4.0, recolored to currentColor</desc><g transform="translate(-20112.718,-703.56027)"><g><path d="M 0,0 C -2.542,-0.369 -5.396,-0.247 -5.483,0.591 -5.569,1.429 -2.68,2.344 -0.147,2.771 2.499,3.216 5.155,3.372 5.575,2.487 5.993,1.607 2.738,0.398 0,0 M -0.07,3.07 C -3.963,2.432 -6.437,1.398 -6.522,0.163 -6.59,-0.819 -4.481,-1.731 0.28,-1.046 c 5.038,0.724 7.075,2.5 6.635,3.479 -0.45,1 -2.977,1.293 -6.985,0.637" style="fill:currentColor;fill-opacity:1;fill-rule:nonzero;stroke:none" transform="matrix(1.3333333,0,0,-1.3333333,20121.416,714.52093)" /><path d="m 0,0 c -0.909,0.834 -0.652,1.825 -1.553,1.825 -0.876,0 -0.62,-0.905 -1.551,-1.825 -0.623,-0.669 -2.434,-0.14 -2.434,-1.214 0,-0.924 1.364,-0.764 2.306,-1.659 0.745,-0.708 0.711,-2.045 1.679,-2.045 0.884,0 0.901,1.516 1.584,2.199 0.957,0.888 2.255,0.578 2.255,1.505 C 2.286,-0.225 0.8,-0.652 0,0" style="fill:currentColor;fill-opacity:1;fill-rule:nonzero;stroke:none" transform="matrix(1.3333333,0,0,-1.3333333,20123.704,705.9936)" /></g></g></svg>';

export default defineConfig({
  lang: "en-US",
  title: "DrFed",
  description:
    "Documentation for DrFed, a web-based platform for developing and debugging ActivityPub apps.",
  cleanUrls: true,
  // Pages include these parts; they are not pages of their own.
  srcExclude: ["installation/container/parts/**"],
  markdown: {
    // Wrapping the default renderers before VitePress applies its plugins
    // runs this after code snippet imports have read their files.  A page's
    // containerEngine rewrites its shell commands, written for Docker, with
    // the same function the container tests run them through.
    preConfig(md) {
      for (const rule of ["fence", "code_inline"] as const) {
        const render = md.renderer.rules[rule]!;
        md.renderer.rules[rule] = (tokens, idx, options, env, self) => {
          const token = tokens[idx]!;
          const engine = (
            env as { frontmatter?: { containerEngine?: unknown } }
          ).frontmatter?.containerEngine;
          const shell = rule === "code_inline" || /^\s*sh\b/u.test(token.info);
          token.content = publishedImage(
            typeof engine === "string" && shell
              ? forEngine(token.content, engine)
              : token.content,
          );
          return render(tokens, idx, options, env, self);
        };
      }
    },
  },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/icon.svg" }],
    ["link", { rel: "me", href: "https://hackers.pub/@drfed" }],
    ["meta", { name: "fediverse:creator", content: "@drfed@hackers.pub" }],
  ],
  themeConfig: {
    logo: { src: "/icon.svg", alt: "" },
    nav: [
      { text: "What is DrFed?", link: "/what-is-drfed" },
      { text: "Installation", link: "/installation/container/" },
      { text: "Manual", link: "/manual/self-hosting" },
      { text: "CLI reference", link: "/reference/cli" },
      { text: "Changelog", link: "/changelog" },
      ...extraNav,
    ],
    sidebar: [
      {
        text: "Introduction",
        items: [{ text: "What is DrFed?", link: "/what-is-drfed" }],
      },
      {
        text: "Installation",
        items: [
          {
            text: "Container image",
            items: [
              { text: "Overview", link: "/installation/container/" },
              { text: "Docker", link: "/installation/container/docker" },
              { text: "Podman", link: "/installation/container/podman" },
              {
                text: "Other container tools",
                link: "/installation/container/other",
              },
            ],
          },
          {
            text: "Run from source",
            link: "/installation/run-from-source",
          },
          {
            text: "Manual installation",
            link: "/installation/manual-installation",
          },
        ],
      },
      {
        text: "Manual",
        items: [
          { text: "Self-hosting", link: "/manual/self-hosting" },
          { text: "Configuration", link: "/manual/configuration" },
        ],
      },
      {
        text: "Reference",
        items: [{ text: "CLI", link: "/reference/cli" }],
      },
      {
        text: "Internals",
        items: [
          { text: "HTTP serving", link: "/internals/http-serving" },
          {
            text: "Configuration resolution",
            link: "/internals/configuration-resolution",
          },
          { text: "Database lifecycle", link: "/internals/database-lifecycle" },
          { text: "Runtime lifecycle", link: "/internals/runtime-lifecycle" },
          { text: "Inbox persistence", link: "/internals/inbox-persistence" },
          {
            text: "Activity deliveries",
            link: "/internals/activity-deliveries",
          },
          { text: "Resource revisions", link: "/internals/resource-revisions" },
        ],
      },
      { text: "Changelog", link: "/changelog" },
    ],
    search: { provider: "local" },
    socialLinks: [
      {
        icon: { svg: HACKERS_PUB_ICON },
        link: "https://hackers.pub/@drfed",
        ariaLabel: "hackers.pub (ActivityPub)",
      },
      {
        icon: "github",
        link: "https://github.com/fedify-dev/drfed",
        ariaLabel: "GitHub",
      },
    ],
    editLink: {
      pattern: "https://github.com/fedify-dev/drfed/edit/main/docs/:path",
    },
    footer: {
      message:
        "Licensed under the GNU AGPL v3 or later.<br>" +
        "hackers.pub icon © 2025 Bak Eunji, " +
        '<a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>, recolored.',
      copyright: "Copyright © 2026 DrFed team",
    },
  },
});
