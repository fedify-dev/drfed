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

// Seeds resource revisions for UI work into the development PGlite store.
// Run it through `mise run seed:revisions` while `mise run dev` is stopped:
// only one process can open the store.
//
// oxlint-disable no-console no-await-in-loop
import { join } from "node:path";
import process from "node:process";

import type { SeedCase, SeededCase } from "./case.mts";
import { ACCESS_CASES } from "./cases-access.mts";
import { DOCUMENT_CASES } from "./cases-documents.mts";
import { SOURCE_CASES } from "./cases-sources.mts";
import { openSeedEnvironment } from "./environment.mts";
import { type Viewer, reportCases } from "./report.mts";
import { createWriter } from "./writer.mts";

const DEFAULT_DATA_PATH = ".pgdata";
const DEFAULT_ROOT_ORIGIN = "http://drfed.localhost:8888";
const CASES: readonly SeedCase[] = [
  ...DOCUMENT_CASES,
  ...SOURCE_CASES,
  ...ACCESS_CASES,
];

// The development server reads its origins from this file; use the same.
try {
  process.loadEnvFile(
    join(import.meta.dirname, "..", "..", "packages", "drfed", ".env"),
  );
} catch {
  // Use the development default when the file is unavailable.
}

async function main(): Promise<void> {
  const dataPath = process.env.usage_data_path ?? DEFAULT_DATA_PATH;
  const rootOrigin = new URL(
    process.env.DRFED_ROOT_ORIGIN ?? DEFAULT_ROOT_ORIGIN,
  );
  const seed = await openSeedEnvironment(dataPath, rootOrigin);
  try {
    const { db, alice, bob, admin } = seed;
    const context = {
      db,
      env: seed.write,
      alice,
      bob,
      writer: createWriter(seed.write, alice),
    };
    const seeded: SeededCase[] = [];
    for (const run of CASES) seeded.push(await run(context));
    const viewers: readonly Viewer[] = [
      { label: "Alice (A)", member: alice.member },
      { label: "Bob (B)", member: bob.member },
      { label: "Admin", member: admin },
      { label: "Anonymous", member: null },
    ];
    console.log(`Seeded ${dataPath} under ${rootOrigin.origin}.`);
    console.log("");
    console.log(
      "Accounts.  The web UI lists only the instances of the account logged " +
        "in, so log in by email as Alice or Bob to see a workspace; the admin " +
        "is a member of none.  The tokens are for GraphQL requests only:",
    );
    for (const { name, email, token } of [alice.member, bob.member, admin]) {
      console.log(`  ${name} <${email}>: ${token}`);
    }
    for (const [label, workspace] of [
      ["A", alice],
      ["B", bob],
    ] as const) {
      console.log(
        `Workspace ${label}: ${workspace.host}, member ${workspace.member.email}, ` +
          `actor @${workspace.actorUsername} ${workspace.actorIri}`,
      );
    }
    console.log("");
    console.log("Each resource below is followed by what every viewer reads.");
    for (const line of await reportCases(seed.graphql, viewers, seeded)) {
      console.log(line);
    }
  } finally {
    await seed.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
