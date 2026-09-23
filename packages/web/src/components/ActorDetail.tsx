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
import { graphql } from "relay-runtime";
import { For, Show } from "solid-js";
import { createFragment } from "solid-relay";

import type { ActorDetail_actor$key } from "./__generated__/ActorDetail_actor.graphql.ts";
import { CopyButton } from "./CopyButton.tsx";

import styles from "~/styles/actor.module.css";

/**
 * Read-only identity and federation information for an actor.
 * @returns The actor identity and endpoint sections.
 */
export function ActorDetail(props: { $actor: ActorDetail_actor$key }) {
  const data = createFragment(
    graphql`
      fragment ActorDetail_actor on Actor @throwOnFieldError {
        handle
        username
        uuid
        type
        created
        iri
        avatarUrl
        inboxUrl
        outbox {
          iri
        }
        followers {
          iri
        }
        following {
          iri
        }
        featured {
          iri
        }
        profileUrl
        instance {
          host
        }
      }
    `,
    () => props.$actor,
  );
  return (
    <Show when={data()}>
      {(actor) => {
        const endpoints = () => [
          { label: "Actor IRI", url: actor().iri },
          { label: "Inbox", url: actor().inboxUrl },
          { label: "Outbox", url: actor().outbox?.iri },
          { label: "Followers", url: actor().followers?.iri },
          { label: "Following", url: actor().following?.iri },
          { label: "Featured", url: actor().featured?.iri },
          { label: "Profile", url: actor().profileUrl },
        ];
        return (
          <>
            <Title>{actor().handle} — DrFed</Title>
            <header class={styles.header}>
              <Show when={actor().avatarUrl}>
                {(url) => (
                  <img
                    class={styles.avatar}
                    src={url()}
                    alt=""
                    width="64"
                    height="64"
                    referrerpolicy="no-referrer"
                  />
                )}
              </Show>
              <div>
                <p class={styles.label}>{actor().type}</p>
                <h1>{actor().handle}</h1>
                <CopyButton value={actor().handle} label="actor handle" />
              </div>
            </header>
            <section class={styles.panel} aria-labelledby="identity-title">
              <h2 id="identity-title">Identity</h2>
              <dl class={styles.fields}>
                <div>
                  <dt>Username</dt>
                  <dd>{actor().username}</dd>
                </div>
                <div>
                  <dt>Instance</dt>
                  <dd>{actor().instance.host}</dd>
                </div>
                <div>
                  <dt>UUID</dt>
                  <dd>{actor().uuid}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>
                    <time dateTime={actor().created}>{actor().created}</time>
                  </dd>
                </div>
              </dl>
            </section>
            <section class={styles.panel} aria-labelledby="endpoints-title">
              <h2 id="endpoints-title">Federation endpoints</h2>
              <dl class={styles.fields}>
                <For each={endpoints()}>
                  {(endpoint) => (
                    <Show when={endpoint.url}>
                      {(url) => (
                        <div>
                          <dt>{endpoint.label}</dt>
                          <dd class={styles.endpoint}>
                            <a href={httpUrl(url())}>{url()}</a>
                            <CopyButton value={url()} label={endpoint.label} />
                          </dd>
                        </div>
                      )}
                    </Show>
                  )}
                </For>
              </dl>
            </section>
          </>
        );
      }}
    </Show>
  );
}

// Stored remote URLs are data, not trusted navigation targets.
function httpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
