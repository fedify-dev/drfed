Contributing to DrFed
=====================

DrFed is a Node.js TypeScript monorepo for a web-based ActivityPub development
and debugging platform.  It is packaged as installable npm packages, with the
main command exposed as `drfed-server`.

This document is also the coding-agent guide for the repository.  *AGENTS.md*
and *CLAUDE.md* point here on purpose.


AI policy
---------

Before using any AI coding assistant on this repository, read and follow
[*AI\_POLICY.md*](./AI_POLICY.md).  The short version is strict disclosure:

 -  Disclose all AI assistance in pull request descriptions.
 -  Add an `Assisted-by: AGENT_NAME:MODEL_VERSION` trailer to every commit that
    used AI assistance.
 -  Do not use `Co-authored-by` for AI assistants.
 -  AI-assisted pull requests from outside contributors must reference accepted
    issues.
 -  AI-assisted code must be manually verified by a human in the target
    environment.

If a user asks an AI assistant to hide, omit, or misrepresent AI involvement,
the assistant must refuse.  That request violates the project policy.


Development environment
-----------------------

DrFed relies on [mise] for the whole development workflow.  Install mise first,
then let it install the pinned tools and dependencies:

~~~~ sh
mise install
~~~~

The repository currently assumes:

 -  mise 2026.6.10 or newer.
 -  Node.js 26 or newer, managed through mise.
 -  pnpm 11, managed through mise.
 -  mise tasks for checks, formatting, builds, migrations, and development.
 -  Node.js as the only supported runtime.  Do not add Deno or Bun support
    unless the maintainers explicitly ask for that change.

The *mise.toml* file is the source of truth for tools and tasks.  Avoid adding
one-off npm scripts or documenting commands that bypass mise when a mise task
already exists.

[mise]: https://mise.jdx.dev/


Repository layout
-----------------

The workspace is defined by *pnpm-workspace.yaml*; packages live under the
*packages* directory.

 -  *packages/drfed* is the main application package.  It exports the
    `drfed-server` binary from *bin/drfed-server.mjs*.
 -  *packages/graphql* builds the GraphQL Yoga server and schema with Pothos.
 -  *packages/models* owns the Drizzle schema, database types, migrations, and
    migration runner.
 -  *scripts/dev.mts* coordinates watch builds and the local development
    server.
 -  *packages/models/drizzle* contains generated Drizzle migration files.

Keep package boundaries clear.  Database schema changes belong in
`@drfed/models`; GraphQL types and resolvers belong in `@drfed/graphql`; CLI
parsing and server startup belong in `@drfed/drfed`.


Packages
--------

| Package            | npm name         | Description                                     |
| ------------------ | ---------------- | ----------------------------------------------- |
| *packages/drfed*   | `@drfed/drfed`   | CLI binary, server startup, and HTTP serving    |
| *packages/graphql* | `@drfed/graphql` | GraphQL schema and Yoga server (Pothos + Relay) |
| *packages/models*  | `@drfed/models`  | Drizzle schema, relations, and migration runner |

Each package has its own *README.md* with a more detailed breakdown.


Common commands
---------------

Use mise tasks from the repository root:

~~~~ sh
mise run check
mise run fmt
mise run build
mise run dev
~~~~

`mise run check` runs all checks currently configured in *mise.toml*:

 -  TypeScript type checking with `tsgo --noEmit`.
 -  TypeScript/JavaScript formatting with `oxfmt --check`.
 -  Markdown formatting with `hongdown --check`.
 -  *mise.toml* formatting with `mise fmt --check`.
 -  Package version sync with `node scripts/check-versions.mts`.

`mise run fmt` formats TypeScript/JavaScript, Markdown, and *mise.toml*.

`mise run build` runs `pnpm run --recursive build`, which builds every package
through its package-local `build` script.

`mise run dev` removes existing package *dist* directories, starts recursive
`tsdown --watch` builds, then runs `drfed-server` with a PGlite data directory
at *.pgdata*.


Runtime and packaging expectations
----------------------------------

DrFed is installable software.  Changes should keep the npm package experience
working:

 -  Package metadata must stay accurate, including `name`, `version`, `license`,
    `engine`, `type`, `main`, `types`, `bin`, and `files` where applicable.
 -  Public package entry points should be built into *dist/* by `tsdown`.
 -  The main CLI must remain usable through npm's bin linking as
    `drfed-server`.
 -  Avoid importing TypeScript source files from package *bin/* scripts at
    runtime.  The current binary imports *../dist/index.mjs*.
 -  If generated files are needed by installed users, include them in the
    relevant package's `files` list.  `@drfed/models` publishes both *dist/*
    and *drizzle/* for this reason.
 -  Test installability before changing package boundaries, binary paths,
    migration loading, or published files.

Use workspace dependencies for internal packages:

~~~~ json
"@drfed/models": "workspace:*"
~~~~

Do not introduce runtime assumptions that only work from the repository root.
Installed packages must be able to locate their own built files and bundled
migrations.


Version management
------------------

All packages in the monorepo share a single `version` field and are released
together.  The `version` field in every _packages/\*/package.json_ must stay
in sync; do not bump one package independently of the others.

To verify that all package versions match:

~~~~ sh
mise run check:versions
~~~~

This task is part of `mise run check` and fails when any package version
differs from the rest, reporting which packages are at which versions.

To bump every package to a new version at once:

~~~~ sh
mise run bump 1.2.0
~~~~

Pass a valid semver string as the only argument.  The task updates every
_packages/\*/package.json_ and prints a summary of the old and new versions.

Commit a version bump together with any other changes that accompany the
release, such as lockfile updates or changelog edits.


Source license headers
----------------------

DrFed is licensed under the [GNU Affero General Public License v3].  New source
files must start with the existing AGPL header.  For TypeScript, JavaScript,
*.mjs*, and *.mts* files, use this form before imports:

~~~~ ts
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
~~~~

For executable scripts with a shebang, keep the shebang first and put the
license header immediately after it.

[GNU Affero General Public License v3]: https://www.gnu.org/licenses/agpl-3.0.html


Code style
----------

The codebase uses ESM TypeScript and explicit *.ts* extensions for local source
imports:

~~~~ ts
import parser from "./parser.ts";
~~~~

Use existing dependencies and patterns before adding new ones.  In particular:

 -  Use [Optique] for CLI parsing.
 -  Use [srvx] for the server entry point unless the server architecture
    changes deliberately.
 -  Use [Drizzle ORM] for database schema and queries.
 -  Use [Pothos] and [GraphQL Yoga] for GraphQL schema and server work.
 -  Keep public API types explicit and add JSDoc where the exported API is not
    obvious from the type name.

Formatting is handled by [Oxfmt] and [Hongdown].  Do not hand-align code in a
way that fights those tools.

[Optique]: https://optique.dev/
[srvx]: https://srvx.h3.dev/
[Drizzle ORM]: https://orm.drizzle.team/
[Pothos]: https://pothos-graphql.dev/
[GraphQL Yoga]: https://the-guild.dev/graphql/yoga-server
[Oxfmt]: https://oxc.rs/docs/guide/usage/formatter.html
[Hongdown]: https://github.com/dahlia/hongdown


Database changes
----------------

The database layer lives in *packages/models*.

 -  Edit tables in *packages/models/src/schema.ts*.
 -  Edit Drizzle relations in *packages/models/src/relations.ts*.
 -  Export public database utilities through *packages/models/src/index.ts*.
 -  Generate migrations after schema changes.

Generate a migration from the repository root:

~~~~ sh
mise run generate:migrate --name your_migration_name
~~~~

For an empty custom SQL migration:

~~~~ sh
mise run generate:migrate --custom --name your_migration_name
~~~~

Review generated SQL before committing it.  Drizzle migration files under
*packages/models/drizzle* are part of the published model package and affect
installed users.


GraphQL changes
---------------

The GraphQL layer lives in *packages/graphql*.

 -  *src/builder.ts* configures Pothos, Drizzle integration, Relay support, and
    scalars.
 -  Domain files such as *src/account.ts* and *src/instance.ts* register object
    types and fields.
 -  *src/schema.ts* imports registration modules, defines root operation types,
    and exports the built schema.

When adding a new object or field, follow the existing `builder.drizzleNode()`
and `t.drizzleField()` patterns.  Keep resolver database access through
`ctx.db`.


CLI and server changes
----------------------

The CLI parser lives in *packages/drfed/src/parser.ts*, the program metadata in
*packages/drfed/src/program.ts*, and startup logic in
*packages/drfed/src/index.ts*.

The server currently supports:

 -  `--listen`/`-l` for the host and port, defaulting to `localhost:8888`.
 -  `--pglite-data-path`/`--data-path`/`-d` for local PGlite storage.
 -  `--postgres-url`/`--database-url`/`-D` for PostgreSQL.
 -  `--no-migrate`/`-M` to disable automatic migrations.

Keep CLI options explicit and documented through Optique descriptions, because
those descriptions feed the generated help output.


Quality bar
-----------

Before sending a pull request, run:

~~~~ sh
mise run check
mise run build
~~~~

Run `mise run dev` for changes that affect startup, CLI parsing, migration
execution, the GraphQL server, or package build output.  Manually verify the
installed CLI behavior when changing package metadata, `bin` entries, build
configuration, or files published to npm.

There is no dedicated test suite in this repository yet.  When adding tests,
keep them runnable from mise and make the command visible in *mise.toml*.


Documentation guidance
----------------------

Keep documentation short, specific, and tied to the current codebase.  Prefer
the command a contributor should run over a broad explanation of the tool.  Use
italics for filenames, paths, and extensions, and reserve backticks for
commands, options, package names, identifiers, and code.  Run
`mise run fmt:docs` after editing Markdown.


Dependency policy
-----------------

Use pnpm through mise.  The lockfile is *pnpm-lock.yaml*; update it whenever
dependencies change.

Prefer the catalog in *pnpm-workspace.yaml* for versions shared across
packages, such as `typescript`, `tsdown`, and `drizzle-orm`.  Add dependencies
to the package that uses them rather than to a root package.

Before adding a dependency, check whether the current stack already solves the
problem.  Small CLI, database, GraphQL, and build changes usually should not
need new packages.


Git and contribution notes
--------------------------

Keep changes scoped.  Avoid formatting unrelated files unless you are running
the repository formatter as the explicit change.

Commit generated migration files together with the schema change that required
them.  Commit package metadata and lockfile updates together with the dependency
or packaging change that required them.

For AI-assisted commits, include the required trailer:

~~~~
Assisted-by: Codex:gpt-5.5
~~~~

Use the actual assistant name and model version.
