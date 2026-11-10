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

import { Show, createMemo, createSignal } from "solid-js";

import { ActivityLogSource } from "./ActivityLogSource.tsx";
import { CopyButton } from "./CopyButton.tsx";

import styles from "~/styles/resource.module.css";

/**
 * Formats JSON as saved for reading.  It is only ever displayed, never read
 * by keys, which aliases and contexts may spell otherwise.
 * @returns The indented JSON text.
 */
export const formatJson = (value: unknown): string =>
  JSON.stringify(value, undefined, 2);

/**
 * Shows JSON as saved in a disclosure, highlighted only once opened.
 * @returns A disclosure holding the JSON and a copy button.
 */
export function JsonDisclosure(props: {
  value: unknown;
  label: string;
  /** Whether it starts open. */
  open?: boolean;
}) {
  // oxlint-disable-next-line solid/reactivity -- Only the initial state.
  const [open, setOpen] = createSignal(props.open === true);
  const source = createMemo(() => (open() ? formatJson(props.value) : ""));
  return (
    <details
      class={styles.json}
      open={open()}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{props.label}</summary>
      <Show when={open()}>
        <CopyButton value={source()} label={props.label} />
        <ActivityLogSource source={source()} json />
      </Show>
    </details>
  );
}
