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

import { graphql } from "relay-runtime";
import { For, Show, createMemo, createSignal } from "solid-js";
import { createFragment } from "solid-relay";

import type { ActivityLogBox_log$key } from "./__generated__/ActivityLogBox_log.graphql.ts";
import { CopyButton } from "./CopyButton.tsx";

/**
 * Displays delivery endpoints and expands to show the recorded JSON-LD.
 * @returns A keyboard-accessible activity disclosure.
 */
export function ActivityLogBox(props: { $log: ActivityLogBox_log$key }) {
  const data = createFragment(
    graphql`
      fragment ActivityLogBox_log on ActivityLog @throwOnFieldError {
        direction
        type
        objectType
        actor {
          iri
        }
        remoteActorIri
        recipientIris
        inboxUrl
        status
        created
        payload
        rawBody
      }
    `,
    () => props.$log,
  );
  const [open, setOpen] = createSignal(false);
  const source = createMemo(() => {
    if (!open()) return "";
    const log = data();
    const payload: unknown = log?.payload;
    return payload == undefined
      ? (log?.rawBody ?? undefined)
      : JSON.stringify(payload, undefined, 2);
  });
  const from = createMemo(() => {
    const log = data();
    if (log?.direction === "inbound") return log.remoteActorIri;
    // Keep the sender visible even if its local actor has since been deleted.
    const payload: unknown = log?.payload;
    const actor: unknown =
      payload != undefined && typeof payload === "object" && "actor" in payload
        ? payload.actor
        : undefined;
    return log?.actor?.iri ?? (typeof actor === "string" ? actor : undefined);
  });
  const to = createMemo(() => {
    const log = data();
    if (!log) return [];
    if (log.direction === "inbound") return [log.actor?.iri ?? log.inboxUrl];
    return log.recipientIris.length > 0 ? log.recipientIris : [log.inboxUrl];
  });

  return (
    <Show when={data()}>
      {(log) => (
        <details
          onToggle={(event) => setOpen(event.currentTarget.open)}
          style={{
            border: "1px solid var(--line)",
            "border-radius": "0.5rem",
            padding: "0.75rem",
          }}
        >
          <summary style={{ cursor: "pointer", "overflow-wrap": "anywhere" }}>
            <strong>
              {log().type ?? "Unknown activity"}
              {log().objectType != undefined && log().objectType !== ""
                ? `(${log().objectType})`
                : ""}
            </strong>
            <span> · {log().status}</span>
            <span style={{ display: "block", "margin-top": "0.5rem" }}>
              From: {from() ?? "Unknown sender"}
            </span>
            <span style={{ display: "block" }}>
              To:{" "}
              <For each={to()}>
                {(iri, index) => (
                  <>
                    {index() > 0 ? ", " : ""}
                    {iri}
                  </>
                )}
              </For>
            </span>
            <time
              style={{ display: "block", "margin-top": "0.5rem" }}
              dateTime={log().created}
            >
              {log().created}
            </time>
            <span style={{ display: "block", "margin-top": "0.5rem" }}>
              {open() ? "Hide source" : "View source"}
            </span>
          </summary>
          <Show when={open()}>
            <p>
              {log().direction === "inbound" && log().payload == undefined
                ? "Raw received body"
                : "JSON-LD"}
              {log().direction === "outbound" ? " (before signing)" : ""}
            </p>
            <Show
              when={source() != undefined}
              fallback={<p>No source recorded.</p>}
            >
              <CopyButton value={source() ?? ""} label="activity source" />
              <pre
                style={{
                  "white-space": "pre-wrap",
                  "overflow-wrap": "anywhere",
                }}
              >
                <code>{source()}</code>
              </pre>
            </Show>
          </Show>
        </details>
      )}
    </Show>
  );
}
