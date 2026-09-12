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

import { Toast, toaster } from "@kobalte/core/toast";
import { Portal } from "solid-js/web";

import styles from "~/styles/toast.module.css";

export function ToastRegion() {
  return (
    <Portal>
      <Toast.Region class={styles.region} duration={5000}>
        <Toast.List class={styles.list} />
      </Toast.Region>
    </Portal>
  );
}

export function showSuccessToast(message: string): number {
  return toaster.show((props) => (
    <Toast toastId={props.toastId} class={styles.toast}>
      <Toast.Title class={styles.title}>{message}</Toast.Title>
      <Toast.CloseButton class={styles.close} aria-label="Dismiss notification">
        <span aria-hidden="true">×</span>
      </Toast.CloseButton>
    </Toast>
  ));
}
