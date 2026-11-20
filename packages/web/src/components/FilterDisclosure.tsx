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

import { type JSX, Show } from "solid-js";

import styles from "~/styles/filter.module.css";

/**
 * A disclosure above a list that opens the conditions it is filtered by,
 * within a `search` landmark.
 * @returns The disclosure, with the number of active conditions on its
 *          toggle.
 */
export function FilterDisclosure(props: {
  /** What the conditions filter, for the group's accessible name. */
  label: string;
  /** How many conditions differ from their defaults. */
  active: number;
  children: JSX.Element;
}) {
  return (
    <search class={styles.filter}>
      <details>
        <summary class={styles.toggle}>
          Filter
          <Show when={props.active > 0}>
            <span class={styles.count}> ({props.active})</span>
          </Show>
        </summary>
        <fieldset class={styles.conditions}>
          <legend class={styles.legend}>Show in {props.label}</legend>
          {props.children}
        </fieldset>
      </details>
    </search>
  );
}

/**
 * One checkbox condition of a {@link FilterDisclosure}.
 * @returns The labelled checkbox.
 */
export function FilterCheckbox(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label class={styles.condition}>
      <input
        type="checkbox"
        class={styles.checkbox}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => {
          props.onChange(event.currentTarget.checked);
        }}
      />
      <span>{props.label}</span>
    </label>
  );
}
