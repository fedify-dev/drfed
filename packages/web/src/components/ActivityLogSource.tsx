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

import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import json from "shiki/langs/json.mjs";
import githubDark from "shiki/themes/github-dark.mjs";
import githubLight from "shiki/themes/github-light.mjs";
import { createMemo } from "solid-js";

import styles from "~/styles/activity-log.module.css";

let highlighter: ReturnType<typeof createHighlighterCoreSync> | undefined;

/**
 * Render recorded source with JSON colours, or plain text for raw bodies.
 * @returns Highlighted, escaped source markup.
 */
export function ActivityLogSource(props: { source: string; json: boolean }) {
  // oxlint-disable-next-line node/no-sync
  highlighter ??= createHighlighterCoreSync({
    langs: [json],
    themes: [githubLight, githubDark],
    engine: createJavaScriptRegexEngine(),
  });
  const renderer = highlighter;
  const html = createMemo(() =>
    renderer.codeToHtml(props.source, {
      lang: props.json ? "json" : "text",
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    }),
  );

  // Shiki escapes source text before producing the highlighted markup.
  // oxlint-disable-next-line solid/no-innerhtml
  return <div class={styles.source} innerHTML={html()} />;
}
