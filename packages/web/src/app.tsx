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

import { MetaProvider, Title } from "@solidjs/meta";
import { A, Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";

import "./styles/drfed.css";
import "./styles/app.css";
import { RelayEnvironmentProvider } from "solid-relay";

import { createRelayEnvironment } from "./RelayEnvironment.ts";

import styles from "./styles/app.module.css";

export default function App() {
  const environment = createRelayEnvironment();

  return (
    <RelayEnvironmentProvider environment={environment}>
      <Router
        root={(props) => (
          <MetaProvider>
            <Title>DrFed</Title>
            <div class={styles.shell}>
              <header class={styles.header}>
                <div class={styles.headerInner}>
                  <A class={styles.brand} href="/" aria-label="DrFed home">
                    <img src="/icon.svg" alt="" width="32" height="32" />
                    <span>DrFed</span>
                  </A>
                  <nav
                    class={styles.navigation}
                    aria-label="Primary navigation"
                  >
                    <A href="/workspace" end activeClass={styles.active}>
                      Workspace
                    </A>
                    <A href="/about" activeClass={styles.active}>
                      About
                    </A>
                  </nav>
                  <A
                    class={styles.headerAction}
                    href="/sign-in"
                    activeClass={styles.active}
                  >
                    Sign in
                  </A>
                </div>
              </header>
              <div class={styles.content}>
                <Suspense>{props.children}</Suspense>
              </div>
            </div>
          </MetaProvider>
        )}
      >
        <FileRoutes />
      </Router>
    </RelayEnvironmentProvider>
  );
}
