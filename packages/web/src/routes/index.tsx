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
import { Show } from "solid-js";
import { createLazyLoadQuery } from "solid-relay";

import type { HomeViewerQuery } from "./__generated__/HomeViewerQuery.graphql";

const homeViewerQuery = graphql`
  query HomeViewerQuery {
    viewer {
      name
      admin
    }
  }
`;

export default function Home() {
  const query = createLazyLoadQuery<HomeViewerQuery>(homeViewerQuery, {});

  return (
    <main>
      <Title>Hello World</Title>
      <h1>Hello world!</h1>
      <Show when={query()?.viewer} fallback={<p>로그인되지 않았습니다.</p>}>
        {(viewer) => (
          <p>
            {viewer().name}
            {viewer().admin ? " (관리자)" : ""}
          </p>
        )}
      </Show>

      <p>
        Visit{" "}
        <a href="https://start.solidjs.com" target="_blank">
          start.solidjs.com
        </a>{" "}
        to learn how to build SolidStart apps.
      </p>
    </main>
  );
}
