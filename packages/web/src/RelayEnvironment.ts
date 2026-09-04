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

import { getCookie } from "@solidjs/start/http";
import {
  Environment,
  type FetchFunction,
  type GraphQLResponse,
  Network,
  RecordSource,
  Store,
} from "relay-runtime";

const SESSION_COOKIE = "session";
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

// oxlint-disable no-async-await
const fetchGraphQL = async (
  query: string,
  variables: Parameters<FetchFunction>[1],
): Promise<GraphQLResponse> => {
  "use server";

  const accessToken = getCookie(SESSION_COOKIE);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (accessToken !== undefined && ACCESS_TOKEN_PATTERN.test(accessToken)) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const url = new URL("/graphql", import.meta.env.VITE_BACKEND_URL);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed (${response.status})`);
  }

  // oxlint-disable return-await no-unsafe-return
  return await response.json();
};

const fetchFn: FetchFunction = async (params, variables) => {
  if (params.text == undefined || params.text == "") {
    throw new Error(`Relay operation ${params.name} has no query text.`);
  }
  const graphQLResponse = await fetchGraphQL(params.text, variables);
  return graphQLResponse;
};

export function createRelayEnvironment() {
  return new Environment({
    network: Network.create(fetchFn),
    store: new Store(new RecordSource()),
  });
}
