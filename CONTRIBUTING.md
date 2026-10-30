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
 -  Add an English provenance summary to the commit body when AI materially
    affected its contents.
 -  Do not use `Co-authored-by` for AI assistants.
 -  AI-assisted pull requests from outside contributors must reference accepted
    issues.
 -  AI-assisted code must be understood and manually verified by a human in
    the target environment.

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
 -  pnpm 12, managed through mise.
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
 -  *packages/federation* registers the ActivityPub dispatchers and inbox
    listeners with Fedify, serializes stored objects and activities, and
    owns the instance host rules.
 -  *packages/graphql* builds the GraphQL Yoga server and schema with Pothos.
 -  *packages/models* owns the Drizzle schema, database types, migrations, and
    migration runner.
 -  *scripts/dev.mts* coordinates watch builds and the local development
    server.
 -  *packages/models/drizzle* contains generated Drizzle migration files.
 -  *docker/* holds the container image's *Containerfile* (*Dockerfile* is a
    symbolic link to it), its entrypoint, and the Compose examples that the
    documentation includes and CI runs.

Keep package boundaries clear.  Database schema changes belong in
`@drfed/models`; ActivityPub handlers and vocabulary serialization belong in
`@drfed/federation`; GraphQL types and resolvers belong in `@drfed/graphql`;
CLI parsing and server startup belong in `@drfed/drfed`.  `@drfed/federation`
must not depend on `@drfed/graphql`.


Packages
--------

| Package               | npm name            | Description                                     |
| --------------------- | ------------------- | ----------------------------------------------- |
| *packages/drfed*      | `@drfed/drfed`      | CLI binary, server startup, and HTTP serving    |
| *packages/federation* | `@drfed/federation` | ActivityPub dispatchers, listeners, and origins |
| *packages/graphql*    | `@drfed/graphql`    | GraphQL schema and Yoga server (Pothos + Relay) |
| *packages/models*     | `@drfed/models`     | Drizzle schema, relations, and migration runner |
| *packages/web*        | `@drfed/web`        | SolidStart frontend web app.                    |

Each package has its own *README.md* with a more detailed breakdown.


Common commands
---------------

Use mise tasks from the repository root:

~~~~ sh
mise run check
mise run fmt
mise run build
mise run test
mise run dev
~~~~

`mise run check` runs all checks currently configured in *mise.toml*:

 -  TypeScript type checking with `tsc --noEmit`.
 -  TypeScript/JavaScript linting with `oxlint`.
 -  TypeScript/JavaScript formatting with `oxfmt --check`.
 -  Markdown formatting with `hongdown --check`.
 -  *mise.toml* formatting with `mise fmt --check`.
 -  Source license header checks with
    `node scripts/add-license/main.mts --check`.
 -  Package version sync with `node scripts/check-versions.mts`.
 -  GitHub workflow and local composite action validation with jactionlint.
 -  Changelog fragment validation and formatting with Sacho.

Run `mise run check:workflows` from the repository root whenever you change a
workflow file. The repository uses jactionlint's `default` profile and
mise-managed ShellCheck. CI runs this same task through `mise run check` on
pull requests and pushes. Use the latest release tags for GitHub Actions.  The
configuration in *.github/jactionlint.yaml* allows version tags instead of
commit hashes for the actions it lists.

`mise run fmt` formats TypeScript/JavaScript, Markdown, and *mise.toml*.

`mise run build` builds the server packages, generates the GraphQL schema, then
runs the Relay compiler and the SolidStart frontend build.

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
mise bump-version 1.2.0
~~~~

Pass a valid semver string as the only argument.  The task updates every
_packages/\*/package.json_, sets *changes.d/next*, and regenerates the
unreleased section of *CHANGES.md* with Sacho.  `mise bump` remains an alias.
Review and commit these files together to start the next release cycle.

Include any accompanying lockfile updates in the version-bump commit.


Changelog and release notes
---------------------------

All five packages share one changelog.  Run `mise run changelog:setup` once
after cloning to register the Git merge drivers declared in *.gitattributes*.
Add a short user-facing entry with
`mise run changelog:add --section DrFed <topic>` and edit the resulting
fragment under *changes.d/*.  Choose `DrFed`, `CLIs`, `GraphQL APIs`, or
`JavaScript/TypeScript APIs` by the interface the reader uses.  Quote section
names containing spaces, as in
`mise run changelog:add --section "GraphQL APIs" <topic>`.
The section comments in *sacho.toml* define their scope and publication order.
Describe the behavior users receive, not the commit history.
Changes with no user-visible effect, including internal refactors, CI, and
contributor instructions, do not need an entry.  Historical commits are not
checked for fragment coverage.

Run `mise exec -- sacho sync` after editing fragments, then run
`mise run fmt:changelog`, `mise run changelog:preview`, and
`mise run check:changelog` before committing.  Sacho owns formatting of
*CHANGES.md* and *changes.d/*; Hongdown excludes them.  With
`materialize = true` in *sacho.toml*, Sacho also keeps the unreleased section
of *CHANGES.md* in sync.  Commit the generated changelog with the fragments.

Before a release, verify all package versions with `mise run check:versions`,
run `mise run changelog:next <version>`, and review the preview.  Run
`mise run changelog:release <version>` locally to freeze the notes and consume
the fragments.  Run the build/check/test gates, commit *CHANGES.md* and the
consumed fragments with the release changes, then tag that commit with the bare
version, such as `0.1.0`.  Tag CI reads the frozen notes; it must not
regenerate them or choose a release date.

After tagging, use
`mise bump-version <next-version>` and commit the package metadata,
*changes.d/next*, and *CHANGES.md* to start the next cycle.  Never bump only
one package.

For changelog work, agents must read the official Sacho skill linked at
*.agents/skills/pnpm-@dahlia+sacho-sacho/SKILL.md*.  Contributors do not need a
global agent plugin.  `mise install` installs the
pinned binary and installs dependencies.  pnpm 12.11 or newer links approved
npm-bundled skills from workspace and root dependencies into *.agents/skills/*
and *.crush/skills/*.  *.claude/skills* points to *.agents/skills/*.
Approvals and destination directories are declared in *pnpm-workspace.yaml*.
Review new dependency skills before adding their `permissions.<package>.skills`
approval.  Standalone skill collections are Git development dependencies;
pnpm locks their source commits and links them alongside package-bundled
skills.  Sources and update instructions are listed in
*.agents/skills/README.md*.

When updating an existing checkout, remove the old `npm-*` symlinks left by
skills-npm in agent skill directories once; keep checked-in skill directories.

Sacho's skill comes from the `@dahlia/sacho` GitHub development dependency,
locked to the release matching the mise binary.  To update Sacho, change the
*mise.toml* pin and run
`mise exec -- pnpm add -Dw github:dahlia/sacho#<version>`.  Review the updated
skill and run `mise exec -- pnpm approve` to approve its new source identity;
Git dependency approvals are tied to the resolved commit.  Run
`mise run changelog:setup` again after installing the new binary to update the
version-specific Git merge-driver path.  Commit the tool pin, root manifest,
lockfile, and approval together.


Automated npm and GitHub releases
---------------------------------

Successful upstream pushes to `main` publish all five packages under the `dev`
dist-tag; `latest` stays unchanged.  CI calculates one identifier such as
`0.1.0-dev.123+abcdef01` from the shared base version, run number, and commit.
npm removes build metadata, so manifests, internal dependencies, and installed
`--version` output use `0.1.0-dev.123`.  The complete identifier and full
commit SHA remain in each package's `drfedBuild` metadata and the artifact
manifest. Keep the version checked in on `main` a stable SemVer version with no
prerelease suffix; CI derives dev identifiers from it.

Release tags are bare SemVer versions with no `v` prefix and must match the
version of every checked-in public package.
Stable tags use `latest`; prerelease tags such as `0.1.0-rc.1` use `next`.
The `v` prefix, build metadata in tags, invalid versions, and mismatched package
versions are rejected.  PRs, forks, deleted refs, and other branches only run
validation and never publish.  Existing Linux/macOS/Windows tests remain
required.  The release workflow waits for the check and test jobs, then builds
with the calculated release version and verifies installation of the exact
packed artifacts through
`mise run --skip-deps test:packaging --artifacts release-artifacts`. Run
`mise run check:release` to exercise the release scripts locally against a
loopback registry, including version, recovery, and GitHub Release fixtures.
This command does not publish to npm or GitHub.

Before enabling automation, an npm maintainer must manually bootstrap all five
public package names with a verified complete package set, publishing models,
federation, GraphQL, web, then the `drfed` facade.  Use public access, a
`bootstrap` dist-tag, and a version lower than every planned release, such as
`0.0.0-bootstrap.0`.  npm also assigns `latest` on the first publication, even
when a custom tag is supplied.
Do not reuse that bootstrap version as an automated release tag.  Build, check,
test, and verify packed local/global installs first; keep the exact tarballs.
For each of `@drfed/models`, `@drfed/federation`, `@drfed/graphql`,
`@drfed/web`, and `@drfed/drfed`, configure an npm trusted publisher for GitHub
organization `fedify-dev`, repository `drfed`, and workflow filename
`main.yaml`.  Enable both *Allow npm publish* and *Allow npm dist-tag*.  These
are separate permissions; dist-tag access is off by default.  Use GitHub-hosted
runners.  The mise pin of npm 12.2.0 supports OIDC dist-tag changes and shadows
Node's bundled npm for CI publication.  The packed-install harness uses Node's
bundled npm separately.  No npm token is supplied to the workflow; publishing
requests provenance and uses the public repository metadata in each package.

The publishing job alone receives `id-token: write`; validation jobs have read
access, and only the separate GitHub Release job receives `contents: write`.
Npm publication and GitHub Release jobs share one concurrency group
(`queue: max`) with cancellation disabled.  The queue has GitHub's
100-pending-job limit; rerun any job cancelled because it was full.
Serialization prevents interleaving.  If an older build finishes late, the
recorded workflow run number keeps `dev` pointing at the newer build, including
after a base-version rollback.  `latest` and `next` use SemVer ordering.
A manually seeded `<base>-dev.0` without build metadata is accepted as an
initial bootstrap only when its base matches the new build's base.  Other
unmanaged `dev` versions still fail the ordering check.
Packages first use the temporary `dev-staging` or `release-staging` dist-tag.
The `dev`, `latest`, or `next` tag advances only after the whole set is
confirmed, and the staging tag is then removed.  Never unpublish as rollback.

Artifacts named `drfed-<run-id>` contain tarballs, identity/integrity metadata,
and, for tag builds, a frozen copy of the release notes.  They are retained for
90 days, subject to the repository's retention limit.

On a rerun, CI reuses the first verified artifact from the same run, requests
fresh registry metadata, and checks each existing version against the original
artifact.  Versions with identical contents are skipped, missing packages are
published, and a mismatch in tarball bytes or build identity fails the run.
CI distinguishes registry/network failures from missing versions and limits
retries.  If npm rejects a retry because the version already exists but its
metadata is not visible yet, CI waits up to five minutes to verify it.
Successful npm uploads and dist-tag changes need no read-after-write
confirmation.

If the original artifact is missing and any package in the set is already
published, recovery fails closed.  Push a new commit to `main` to produce a new
dev build, or prepare a new reviewed patch tag.  Do not rebuild an existing
immutable version.  Immediately before registry writes and GitHub Release
writes, CI checks again whether the release tag has been deleted or moved.

After npm publication, tag builds create or verify the GitHub Release from
`CHANGES.md` and upload the same verified tarballs.  Reruns keep an existing
release whose notes, prerelease flag, and asset digests match, upload missing
assets, and fail on conflicts.  Empty `starter` assets left by failed uploads
are replaced; completed assets are never clobbered.  A stable GitHub Release is
marked Latest only when it matches npm `latest`.  Main builds create no GitHub
Release.  Tag builds also attach 20 completion scripts for all four commands
and all five shells, named *drfed-server.bash*, *drfed-server.zsh*, and so on.
These assets are extracted from the same verified application tarball that is
published to npm.  Their manifest digests and tarball contents are checked
before release uploads; reruns reuse matching assets and upload missing files.
Each GitHub Release also attaches *image-manifest.json*, which ties the
container image digest to the release tarballs.


Container images
----------------

The image `ghcr.io/fedify-dev/drfed` is built from *docker/Containerfile*,
only from the verified tarballs of the same run, never from a registry
dist-tag.  Keep the file free of BuildKit-only syntax so that other OCI
builders can use it.  Build and test it locally with Docker or Podman:

~~~~ sh
mise run image:build
mise run test:image
~~~~

`image:build` packs the workspace unless `--artifacts` names a tarball
directory, and writes an OCI layout to *image-artifacts/linux-<arch>/*.  It
builds with `--engine docker` or `--engine podman`; without the option it uses
Docker when Docker is reachable, and Podman otherwise.  Either engine writes
one OCI image manifest with gzip layers, the same image labels, and the same
*drfed-image.json*, and either engine can test the result.  Only Docker layouts
are released, so the manifest annotations and *index.json* entries that differ
between the engines are never published.

`test:image` loads that exact layout and runs the four commands, the Compose
examples under *docker/*, the backup and restore snippets, and an upgrade from
the source named in *docker/upgrade-source.json*.  It runs
`test:image:docker`, then `test:image:podman`; `--parallel` runs them at the
same time, which needs memory for both engines' virtual machines on macOS.  An
engine whose command is not installed is skipped with a message, and
`--require` turns that into a failure, as CI does.  An installed engine that
cannot be reached, such as a stopped Docker Desktop or `podman machine`, always
fails.  Run the tests after changing *docker/*, packaging, startup, or
migrations.

The scripts live under *scripts/images/*.  Engine differences are data in
*scripts/images/engines.mts*: command arguments, the environment, platform and
image ID formats, and the build steps.  To support another container engine,
add an entry there, add a `test:image:<tool>` task, and add that task to
`test:image`. The scenarios under *scripts/images/test/scenarios/* do not name
any engine. `mise run check:images` tests the calculations in *engines.mts*,
including how the Podman documentation rewrites the Docker commands.

In CI, pull requests build the image with Docker and with Podman on
`linux/amd64` and `linux/arm64` runners and test each layout with the engine
that built it, without uploading anything.  Release builds use Docker and test
the same layout with Docker, then Podman.  Release builds keep each tested
layout as a `drfed-image-<run-id>-<arch>` artifact and merge them into one OCI
image index, kept as `drfed-image-index-<run-id>`.  The npm `publish` job
requires that index, so a broken image blocks the whole release set.  The
`image-publish` job then runs in the `npm-publish` concurrency group:

 -  It pushes the index as the immutable `<version>` tag.  An existing tag with
    the same digest is skipped; a different digest fails the run.
 -  It attests the index digest with `actions/attest` and requires the
    attestation to verify both from GitHub and from the registry.  If a
    previous attempt stored it on GitHub only, the job attaches that stored
    bundle instead of creating another one.
 -  It moves the `dev`, `latest`, or `next` channel tag only forward, using
    the `org.drfed.build` annotation with the same ordering rules as npm.
 -  It finally resolves the channel tag without credentials.  If the package
    is private, `latest` and `next` builds fail and `dev` builds only warn.

To recover from a failed image publication after npm publication succeeded,
rerun the same workflow run; it reuses every artifact and pushes identical
bytes.  If the artifacts have expired, prepare a new patch release instead of
rebuilding a published version; the `image` job refuses to build a missing
layout again once the version is on npm.  Every registry write, including
attaching an attestation, first checks that the release tag still names the
built commit.  `mise run check:release` exercises these
rules with stub `crane` and `gh` commands.

After the first `main` build publishes the package, a maintainer must check its
visibility in the organization's package settings.  If it is private, make it
public, which cannot be undone, confirm that the package is linked to this
repository with Actions write access, and rerun any job that failed the
anonymous pull check.  After each stable release, the next version bump commit
should point *docker/upgrade-source.json* at that release's image, pinned by
digest.  `mise bump-version` updates the image tags of the Compose examples,
and `mise run check:versions` checks them.

Documentation site deployment and its service setup are described in
[*DEPLOY.md*](./DEPLOY.md).


Source license headers
----------------------

DrFed is licensed under the [GNU Affero General Public License v3].  Every new
source file (including test files matching *.test.ts* and management scripts
under *scripts/*) must start with the existing AGPL header.  For TypeScript,
JavaScript, *.mjs*, and *.mts* files, use this form before imports:

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

When you leave a `FIXME` comment, open a GitHub issue that describes the
problem and the intended change, and put only the issue URL in the comment:

~~~~ ts
// FIXME: https://github.com/fedify-dev/drfed/issues/35
~~~~

Keep the details in the issue rather than in the comment, and update the issue
when the plan changes.

[Optique]: https://optique.dev/
[srvx]: https://srvx.h3.dev/
[Drizzle ORM]: https://orm.drizzle.team/
[Pothos]: https://pothos-graphql.dev/
[GraphQL Yoga]: https://the-guild.dev/graphql/yoga-server
[Oxfmt]: https://oxc.rs/docs/guide/usage/formatter.html
[Hongdown]: https://github.com/dahlia/hongdown


Unit tests
----------

Test files live in the same package *src/* directory as the source they test
and follow the `*.test.ts` naming convention.

Use the built-in `node:test` runner and import `node:assert/strict` under the
name `assert`:

~~~~ ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
~~~~

Import the module under test through its package subpath export, not through a
relative source path:

~~~~ ts
// correct
import { normalizeEmail } from "@drfed/models/email";

// wrong — do not do this
import { normalizeEmail } from "./email.ts";
~~~~

Using the package import exercises the built *dist/* output and catches
discrepancies between source and what consumers actually receive.  Build the
package before running tests (`pnpm --filter <package> run build` or
`mise run build`).

If the module under test is not yet listed as a subpath export, add it to the
`exports` field in the package's *package.json* and to the `entry` array in
the `tsdown` configuration before writing tests:

~~~~ json
"exports": {
  "./email": {
    "types": "./dist/email.d.mts",
    "default": "./dist/email.mjs"
  }
},
"tsdown": {
  "entry": ["src/index.ts", "src/email.ts"]
}
~~~~

Every package except `@drfed/web` exposes a `test` npm script that runs
Node.js's built-in test runner:

~~~~ json
"scripts": {
  "test": "node --test"
}
~~~~

Run all tests across the monorepo from the repository root (builds first
automatically):

~~~~ sh
mise run test
~~~~


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
installed users. See [database lifecycle internals] for migration integrity,
preparation and persistent-store ownership.

[database lifecycle internals]: https://drfed.org/internals/database-lifecycle


Federation changes
------------------

The ActivityPub layer lives in *packages/federation*.

 -  *src/index.ts* exports `buildFederation()`, which creates a fresh Fedify
    builder and registers every dispatcher and listener on it, and
    `createFederation()`, which builds it with the given Fedify options.
 -  *src/actor.ts*, *src/object-dispatchers.ts*, *src/collection.ts*, and
    *src/inbox.ts* each register one group of handlers on the builder they
    are given.  Do not register anything on a module-level builder.
 -  *src/object.ts* holds the query selections and serializers for stored
    objects and activities.  GraphQL mutations use the same serializers to
    build the JSON-LD documents they store, so that stored documents and
    ActivityPub responses never diverge.
 -  *src/origin.ts* holds the instance host rules; see below.

Activity delivery observations live in `activity_deliveries`, independently
of the ActivityPub `activities` resources, and *src/activity-delivery/* holds
the code that records them.  The federation HTTP surface must pass through
`createInboundRecorder` with a federation made by `createFederation`, which
captures Fedify's `onRequestFinished()` report for each request, and the
deployment's root origin.  Take verification keys and refusal reasons from
that report; never verify a request again or infer its outcome from telemetry
or public-key cache serialization. Inbox listeners must call
`markHandled()`, which is how a delivery tells a received activity from an
acknowledged one.  Use `deliverActivity` for outgoing delivery, and create the
federation through `createFederation`, which observes the outbox queue so that
each attempt Fedify's worker makes settles its delivery.

The `Create` listener stores what it accepts through *src/inbox-persist.ts*.
An inbound delivery that was verified and answered with 2xx is linked to
`activities` by the activity IRI it recorded, through `linkInboundActivity`,
never by what a listener reports.

See [inbox persistence internals] for acceptance and idempotence, and
[activity delivery internals] for completion reports, receipts and queue
observations.

[inbox persistence internals]: https://drfed.org/internals/inbox-persistence
[activity delivery internals]: https://drfed.org/internals/activity-deliveries


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

The GraphQL types for activity deliveries live in
*src/activity-delivery/entry.ts*.  Delivery contents are private to local
instance members and administrators, including Relay node lookups.


CLI and server changes
----------------------

The CLI parser lives in *packages/drfed/src/parser.ts*, the program metadata in
*packages/drfed/src/program.ts*, and startup logic in
*packages/drfed/src/index.ts*.

The server currently supports:

 -  `--root-origin`/`-r` for the origin instances are subdomains of.  Required.
 -  `--listen`/`-l` for the host and port, defaulting to `localhost:8888`.
 -  `--pglite-data-path`/`--data-path`/`-d` for local PGlite storage.
 -  `--postgres-url`/`--database-url`/`-D` for PostgreSQL.
 -  `--no-migrate`/`-M` to disable automatic migrations.
 -  `--email-from`/`-f` for the sender of login mail, defaulting to `noreply@`
    at the root origin's host name.
 -  `--smtp-url`/`-s` for the SMTP server to deliver mail through.

Keep CLI options explicit and documented through Optique descriptions, because
those descriptions feed the generated help output.  Options that name a web
origin should use Optique's `origin()` value parser rather than `url()`, so
that every spelling of the same origin is normalized the same way.
*packages/drfed/src/valueparser.ts* wraps it as `rootOrigin()` to add the two
rules that are DrFed's own: the root origin may not name an IP address, since
every instance is a subdomain of it, and its host name may not run past the 253
octets DNS allows, since login mail is sent from that domain.

Requests are routed by the authority they arrive on, in
*packages/drfed/src/serving.ts*.  A subdomain one label below the root origin
is an instance and serves ActivityPub only; the root origin and every other
authority serve GraphQL and never answer as an instance; anything deeper under
the root domain is answered 421, and an unusable `Host` header 400.  The
classification itself lives in *packages/federation/src/origin.ts* alongside
the functions that compose an instance's authority, so that the two can never
disagree about what an instance host looks like.  Anything that changes how a
host is composed or compared belongs there, not in the server.


Quality bar
-----------

Before sending a pull request, run:

~~~~ sh
mise run build
mise run check
mise run test
~~~~

Build first.  `mise run check` type-checks each package against the *dist/* of
the ones it depends on, so on a fresh checkout, or after adding a subpath
export, checking before building reports missing modules that are not actually
missing.  This is the order CI uses.

Run `mise run dev` for changes that affect startup, CLI parsing, migration
execution, the GraphQL server, or package build output.  Run
`mise run image:build` and `mise run test:image` for changes to *docker/* or
to what the container image runs.  Manually verify the
installed CLI behavior when changing package metadata, `bin` entries, build
configuration, or files published to npm.


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
Assisted-by: AGENT_NAME:MODEL_VERSION
~~~~

Use the actual assistant name and model version.
