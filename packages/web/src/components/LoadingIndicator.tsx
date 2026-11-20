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

import styles from "~/styles/loading.module.css";

/**
 * An indeterminate progress bar named by its visible label, for a part of a
 * page that is loading.  A progress bar tells assistive technology of the
 * wait without the noise of a live region.
 * @returns The labelled progress bar.
 */
export function LoadingIndicator(props: { label: string }) {
  return (
    <label class={styles.loading}>
      <progress class={styles.bar} />
      <span>{props.label}</span>
    </label>
  );
}
