Agent skills
============

pnpm installs and links every skill in this directory. The source commits and
tarball integrity are recorded in *pnpm-lock.yaml*. There are no checked-in
skill copies. *.claude/skills* points to this directory; pnpm also links the
same dependency skills into *.crush/skills/*.

| Git development dependency  | Skills                                      | Source                             |
| --------------------------- | ------------------------------------------- | ---------------------------------- |
| `@open-circle/agent-skills` | `formisch`, `valibot`                       | [open-circle/agent-skills]         |
| `@chillicream/agent-skills` | `graphql-schema-design`                     | [ChilliCream/agent-skills]         |
| `relay-github-root`         | `relay-best-practices`, `relay-performance` | [facebook/relay]                   |
| `@dahlia/sacho`             | `sacho`                                     | [dahlia/sacho]                     |
| `modern-web-guidance`       | `modern-web-guidance`, `chrome-extensions`  | [GoogleChrome/modern-web-guidance] |
| `@leonxlnx/taste-skill`     | `design-taste-frontend`                     | [leonxlnx/taste-skill]             |

The pinned skill contents match the latest upstream versions checked during
this migration. ChilliCream is pinned to the last change to its GraphQL schema
skill, before unrelated skills were added to the collection; that skill and
its references still match the default branch. Sacho's skill also matches its
default branch while retaining the release tag matching the mise binary.

Relay's repository root declares its own development dependencies and a build
script. *.pnpmfile.mjs* removes dependency edges from `relay-github-root`, since
only its skills are used here. Its build permission is explicitly denied.
The application's `relay-runtime`, Relay compiler, and other dependencies keep
their existing dependency graphs.

Fedify, LogTape, Optique, and Solid Relay skills come from the application
packages already installed in the workspace and follow those package versions.

To update a Git collection, review the complete upstream *skills/* directory,
then run `mise exec -- pnpm add -Dw github:owner/repo#<revision>` and
`mise exec -- pnpm approve`. Approval covers all skills in that source and is
tied to its resolved commit. Commit *package.json*, *pnpm-lock.yaml*, and the
updated source approval in *pnpm-workspace.yaml* together.

[open-circle/agent-skills]: https://github.com/open-circle/agent-skills
[ChilliCream/agent-skills]: https://github.com/ChilliCream/agent-skills
[facebook/relay]: https://github.com/facebook/relay
[dahlia/sacho]: https://github.com/dahlia/sacho
[GoogleChrome/modern-web-guidance]: https://github.com/GoogleChrome/modern-web-guidance
[leonxlnx/taste-skill]: https://github.com/leonxlnx/taste-skill
