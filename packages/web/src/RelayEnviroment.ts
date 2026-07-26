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

import {
  Environment,
  type FetchFunction,
  Network,
  RecordSource,
  Store,
} from "relay-runtime";
import { getRequestEvent } from "solid-js/web";

import { readSessionCookie } from "./routes/session.ts";

// oxlint-disable no-async-await
const fetchFn: FetchFunction = async (params, variables) => {
  const event = getRequestEvent();
  const accessToken = readSessionCookie(event?.request);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (accessToken !== undefined) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  const response = await fetch(import.meta.env.VITE_DRFED_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: params.text,
      variables,
    }),
    credentials: "include"
  });

  // oxlint-disable return-await no-unsafe-return
  return await response.json();
};

export function createRelayEnvironment() {
  return new Environment({
    network: Network.create(fetchFn),
    store: new Store(new RecordSource()),
  });
}
