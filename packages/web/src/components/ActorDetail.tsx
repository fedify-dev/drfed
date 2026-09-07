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
import { Show } from "solid-js";
import { createFragment } from "solid-relay";

import type { ActorDetail_actor$key } from "./__generated__/ActorDetail_actor.graphql.ts";

import styles from "~/styles/instance.module.css";

export const ActorDetail = (props: { $actor: ActorDetail_actor$key }) => {
  const actorData = createFragment(
    graphql`
      fragment ActorDetail_actor on Actor {
        handle
      }
    `,
    () => props.$actor,
  );

  return (
    <Show when={actorData()}>
      {(actor) => (
        <article class={styles.actorCard}>
          <span class={styles.actorMarker} aria-hidden="true" />
          <p>{actor().handle}</p>
        </article>
      )}
    </Show>
  );
};
