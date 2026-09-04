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

import { Link } from "@kobalte/core/link";
import { Title } from "@solidjs/meta";
import { Show } from "solid-js";

// oxlint-disable-next-line capitalized-comments
// import type { InstanceDetailQuery } from "./__generated__/InstanceDetailQuery.graphql";

// const instanceDetailQuery = graphql`
//   query InstanceDetailQuery($instanceSlug: String!) {
//     instance: node(slug: $instanceSlug) {
//       ... on Instance {
//         host
//         nodeInfoUrl
//       }
//     }
//   }
// `;

// const loadInstanceQuery = query(
//   (instanceSlug: string) =>
//     loadQuery<InstanceDetailQuery>(
//       useRelayEnvironment()(),
//       instanceDetailQuery,
//       {
//         instanceSlug,
//       },
//     ),
//   "InstanceDetailQuery",
// );

// export const route = {
//   preload({ params }) {
//     if (params.slug === undefined) {
//       throw new Error("Missing slug route parameter.");
//     }
//     return loadInstanceQuery(params.slug);
//   },
// } satisfies RouteDefinition;

// type RouteData = ReturnType<typeof loadInstanceQuery>;

export default function InstanceDetailPage() {
  // oxlint-disable-next-line capitalized-comments
  // const data = createPreloadedQuery<InstanceDetailQuery>(
  //   instanceDetailQuery,
  //   () => props.data,
  // );
  //

  // oxlint-disable-next-line  unicorn/consistent-function-scoping
  const data = () => ({
    instance: {
      host: "hi",
      nodeInfoUrl: "bye",
    },
  });

  return (
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    <Show when={data()?.instance} fallback={<p>Instance not found.</p>}>
      {(instance) => (
        <main>
          <Title>{instance().host} — DrFed</Title>
          <h1>{instance().host}</h1>
          <Show when={instance()}>
            {/*oxlint-disable-next-line eslint/no-shadow */}
            {(instance) => (
              <Show when={instance().nodeInfoUrl}>
                {(nodeInfoUrl) => (
                  <p>
                    NodeInfo: <Link href={nodeInfoUrl()}>{nodeInfoUrl()}</Link>
                    WebFingerURL:{" "}
                    <Link href="">{`${instance().host}/.well-known/webfinger`}</Link>
                    SharedInbox: <Link>TBD</Link>
                  </p>
                )}
              </Show>
            )}
          </Show>
        </main>
      )}
    </Show>
  );
}
