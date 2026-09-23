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

import { createSignal } from "solid-js";

import styles from "~/styles/buttons.module.css";

/**
 * Copy a value to the clipboard and announce the result.
 * @returns A copy button with accessible feedback.
 */
export function CopyButton(props: { value: string; label: string }) {
  const [message, setMessage] = createSignal("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.value);
      setMessage("Copied.");
    } catch {
      setMessage("Could not copy. Select and copy the text manually.");
    }
  }
  return (
    <span class={styles.copyControl}>
      <button
        type="button"
        onClick={() => {
          void copy();
        }}
        aria-label={`Copy ${props.label}`}
      >
        Copy
      </button>
      <output>{message()}</output>
    </span>
  );
}
