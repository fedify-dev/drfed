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

import { Title } from "@solidjs/meta";
import { A, useParams } from "@solidjs/router";
import { For } from "solid-js";

import styles from "~/styles/instance.module.css";

const actors = ["@sherry", "@newsroom", "@garden"] as const;

export default function InstanceDetailPage() {
  const params = useParams();
  const host = () => params.slug ?? "social.example";

  return (
    <main class={styles.page}>
      <Title>{host()} — DrFed</Title>

      <A class={styles.backLink} href="/workspace">
        <span aria-hidden="true">←</span> All instances
      </A>

      <header class={styles.header}>
        <h1>{host()}</h1>
        <A
          class={styles.createButton}
          href="/workspace/create/instance-demo/actors"
        >
          <span aria-hidden="true">＋</span>
          Create actor
        </A>
      </header>

      <section class={styles.details} aria-labelledby="connection-title">
        <div>
          <p class={styles.sectionLabel}>Connection record</p>
          <h2 id="connection-title">Federation endpoints</h2>
        </div>
        <dl class={styles.endpointList}>
          <div>
            <dt>NodeInfo</dt>
            <dd>
              <a href={`https://${host()}/nodeinfo/2.1`}>/nodeinfo/2.1</a>
            </dd>
          </div>
          <div>
            <dt>WebFinger</dt>
            <dd>
              <a href={`https://${host()}/.well-known/webfinger`}>
                /.well-known/webfinger
              </a>
            </dd>
          </div>
          <div>
            <dt>Shared inbox</dt>
            <dd>
              <a href={`https://${host()}/inbox`}>/inbox</a>
            </dd>
          </div>
        </dl>
      </section>

      <section class={styles.actors} aria-labelledby="actors-title">
        <header class={styles.sectionHeader}>
          <div>
            <p class={styles.sectionLabel}>Local identities</p>
            <h2 id="actors-title">Actors</h2>
          </div>
          <p>{actors.length} registered</p>
        </header>

        <div class={styles.actorList}>
          <For each={actors}>
            {(handle) => (
              <article class={styles.actorCard}>
                <span class={styles.actorMarker} aria-hidden="true" />
                <p>
                  {handle}@{host()}
                </p>
              </article>
            )}
          </For>
        </div>
      </section>
    </main>
  );
}
