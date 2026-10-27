Deploying DrFed
===============

This guide is for maintainers.  It covers deployments that the documentation
site itself does not describe.


Deploying DrFed itself
----------------------

Running a DrFed server is documented on the documentation site, not here:

 -  [Self-hosting] (*docs/manual/self-hosting.md*)
 -  [Configuration] (*docs/manual/configuration.md*)
 -  [Installation] (*docs/installation/*)

Publishing the npm packages, the container image, and GitHub Releases is
covered in
[*CONTRIBUTING.md*](./CONTRIBUTING.md#automated-npm-and-github-releases).
The rest of this guide covers the documentation site only.

[Self-hosting]: https://drfed.org/manual/self-hosting
[Configuration]: https://drfed.org/manual/configuration
[Installation]: https://drfed.org/installation/docker


Documentation site requirements
-------------------------------

These rules hold for any host.  Only the deployment steps, credentials, and
domains change when the site moves to another host.

`mise run build:docs` writes static files to *docs/.vitepress/dist/*.  The site
has no server code.  A host must:

 -  serve */path* from *path.html* without a redirect loop, since the site uses
    VitePress `cleanUrls: true`;
 -  serve the top-level *404.html* for missing pages;
 -  serve HTTPS.

The build reads `EXTRA_NAV_TEXT` and `EXTRA_NAV_LINK` to add a navigation link
to the other public site.  Without them no link is added.  It also reads
`DRFED_IMAGE_VERSION`, which replaces the image tag in container examples with
the version the same workflow run published; without it the examples keep the
checked-in version.

There are three targets:

 -  *Release* (`https://drfed.org`): built from a release tag with a `Canary`
    link.  Deployed only after the tag's npm publication, image publication,
    and GitHub Release have all succeeded.
 -  *Canary* (`https://canary.drfed.org`): built from a `main` commit with a
    `Release` link.  Deployed only after that commit's checks, tests, `dev`
    npm publication, and image publication have all succeeded.
 -  *Preview*: built from a pull request's merge ref
    (*refs/pull/<n>/merge*, the head merged into the base branch) with no
    extra link, at a fixed URL per pull request.  The preview comment names
    the head commit.  Deployed when the pull request run was not cancelled
    and its documentation build succeeded, even if tests failed.  Fork pull
    requests get previews too, but only once a maintainer approves their
    workflow run when the repository's approval policy holds it.

Rules for the two public sites:

 -  Failed or cancelled runs never deploy.
 -  Forks and branches other than `main` never update either public site.
 -  A rerun of an older run does not deploy once a newer version's
    documentation has been deployed.  `mise run docs:verify-current` compares
    the build with the last deployment that reached the site.  Release builds
    compare by SemVer across the `latest` and `next` channels; canary builds
    compare by workflow run number.
 -  Each deployment is recorded before its upload and settled after it, so a
    build that reached the site still blocks older builds when its job fails
    before recording that.  `mise run docs:record-intent <dir>` records an
    in-progress deployment and writes *drfed-docs-build.json*, which names the
    build, into the site.  `mise run docs:record-deployment` marks the
    deployment successful after the upload.  When `docs:verify-current` finds
    a deployment that is neither successful nor inactive, it reads
    *drfed-docs-build.json* from the site: if the site names that build, the
    deployment is marked successful, otherwise inactive.  A site that cannot
    be read, or names a malformed build, fails the job without changing the
    records.
 -  Because `latest` and `next` share `drfed.org`, a stable patch released
    while a higher prerelease is deployed (say 0.2.1 after 0.3.0-rc.1) is
    skipped with a warning annotation until a newer version is deployed.

Rules for every target:

 -  A build that contains *\_worker.js*, *\_routes.json*, or *functions/*,
    or that lacks *index.html*, is refused, as is a *functions/* directory at
    the repository root, where Wrangler runs.  The GitHub Pages job checks the
    downloaded build with `mise run docs:verify-dist <dir>`.  The Cloudflare
    jobs run `mise run docs:deploy <dir>`, which makes the same check itself
    before it starts Wrangler, so it cannot be skipped.
 -  Pull request code never runs where deployment credentials are available.
 -  The deployment jobs install only Node.js and, where they deploy to
    Cloudflare, Wrangler, before any step that receives a secret.  They
    install no project dependencies and run no repository hooks: they set
    `MISE_NO_HOOKS=1` and `MISE_AUTO_INSTALL=false` and run every task with
    `mise run --no-deps --skip-tools`, so the Cloudflare deployment step uses
    the Wrangler installed before it and installs nothing itself.


Current setup: GitHub Pages and Cloudflare Pages
------------------------------------------------

### Jobs

 -  *.github/workflows/main.yaml* `docs`: builds the site on every event and
    uploads it as the `docs-<run-id>` artifact.  It uses no secrets.
 -  *.github/workflows/main.yaml* `docs-release`: deploys release tags to
    GitHub Pages after `github-release`.
 -  *.github/workflows/main.yaml* `docs-canary`: uploads `main` builds to
    Cloudflare Pages as production deployments after `check`, `test`, and
    `publish`.
 -  *.github/workflows/docs-preview.yaml* `preview`: runs on `workflow_run`
    after a pull request run of `main`, uploads a Cloudflare Pages preview,
    and posts or updates a comment on the pull request.

### Repository settings

Complete these settings, and the Cloudflare project below, *before* merging
the change that adds these jobs.  On pushes to `fedify-dev/drfed`, the `docs`
job of a tag build requires `CANARY_DOCS_URL` for its `Canary` link, and that
of a `main` build requires `RELEASE_DOCS_URL` for its `Release` link.  Without
the variable that job fails and its site is not deployed until the variable is
set and the failed jobs are re-run.  Pull requests, other branches, and forks
build without a link whether or not the variables exist.  Without
`CLOUDFLARE_PROJECT_NAME`, canary and preview deployments fail.

 -  Secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
 -  Variables: `CLOUDFLARE_PROJECT_NAME=drfed-docs`,
    `RELEASE_DOCS_URL=https://drfed.org`, and
    `CANARY_DOCS_URL=https://canary.drfed.org`.
 -  *Settings* → *Pages* → *Build and deployment* → *Source*:
    *GitHub Actions*.  No *CNAME* file is needed; the custom domain is stored
    in the repository settings.
 -  *Settings* → *Environments* → `github-pages` → *Deployment branches and
    tags*: add the tag rule `*.*.*`.  The generated environment only allows the
    default branch.
 -  `fedify-dev` organization *Settings* → *Pages* → *Add a domain*: verify
    `drfed.org` with the TXT record
    `_github-pages-challenge-fedify-dev.drfed.org`, and keep the record.

The `docs-canary` job uses the `canary-docs` environment without protection
rules.  Ordering records live in the `docs-release` and `docs-canary`
environments as GitHub deployments; the jobs create them.

### Cloudflare Pages

Create an API token with a single permission, *Account* → *Cloudflare
Pages* → *Edit*.  The account ID is shown on the account or zone overview.
Then create the Direct Upload project.  Install Wrangler first, without
credentials, and run both commands outside the repository checkout:

~~~~ sh
cd "$(mktemp -d)"
mise install node@26 npm:wrangler@4.149.0
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
  mise exec node@26 npm:wrangler@4.149.0 -- \
  wrangler pages project create drfed-docs --production-branch main
~~~~

Inside the checkout, `mise install` would run the repository's `postinstall`
hook, which installs every project tool and runs `pnpm install`, and
`mise exec` would run `pnpm install` with the token in its environment.  Use
the Wrangler version pinned by the `docs:deploy` task in *mise.toml*.

Do not connect a Git repository.  A Direct Upload project has no Cloudflare
builds, so nothing can bypass the GitHub Actions gates, and it cannot be
switched to Git integration later.  In the project's *Custom domains*, add
`canary.drfed.org`; because the zone is on Cloudflare, the `canary` CNAME to
`drfed-docs.pages.dev` is created automatically.  Leave the project's access
policy off so that outside contributors can open previews.

Wrangler is not a project dependency.  It is a task-level tool of the
`docs:deploy` task in *mise.toml* (`npm:wrangler`), so contributor installs
and the npm publishing job never download it.  The `docs-canary` and `preview`
jobs install the same version through the `install_args` of
`jdx/mise-action`; update the task and both jobs together.  If they differ,
the deployment step fails instead of installing Wrangler.

`mise run docs:deploy <dir>` reads `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PROJECT_NAME`, `DOCS_BRANCH` (`main` or
`pr-<n>`), and `DOCS_COMMIT` (a full commit SHA), and refuses to start
Wrangler when any is missing or malformed.  It passes no commit message,
since a preview's would come from the pull request author.  It writes the
`deployment-url` and `alias-url` step outputs.  Only the deployment step
receives the Cloudflare secrets, and that step receives no GitHub token.

### Pull request previews

Same-repository and fork pull requests take the same path.  Cloudflare's
automatic Git previews do not exist here, because the project has no Git
integration.

1.  The pull request run of `main` builds the site from the merge ref without
    secrets and uploads the artifact.  A fork's run may first wait for a
    maintainer's approval.
2.  `preview` runs from the default branch's workflow file and checks out the
    default branch, never the pull request.  It finds the open pull request
    whose head is the run's commit, requires that run's latest `docs` job to
    have succeeded, and downloads only the artifact.  The artifact goes
    outside the checkout, so that nothing in it can shadow a checked-out file
    and Wrangler does not see a dirty working tree.
3.  It runs `mise run docs:deploy` with `DOCS_BRANCH=pr-<n>` and the head
    commit as `DOCS_COMMIT`, so the stable URL is
    `https://pr-<n>.drfed-docs.pages.dev`.  It then updates one marked comment
    from `github-actions[bot]` with the `alias-url` and `deployment-url`
    outputs.

jactionlint flags `workflow_run` as a dangerous trigger.  It is accepted
deliberately: the job treats the event payload and the artifact as untrusted
input and checks both before using them.

Runs for the same head branch are serialized, so that an older run cannot
deploy over a newer one.  The concurrency group starts with the head
repository's numeric ID, which cannot contain the separator, so forks with
the same branch name never share a group.

Credentials never reach pull request code.  Previews are a separate origin
from `canary.drfed.org`, and Cloudflare sends `X-Robots-Tag: noindex` on every
preview deployment.  Changes to *docs-preview.yaml* take effect only after they
reach `main`.

### Recovering the ordering records

A job that fails after recording its intent needs no action: the next
deployment to the same site settles the intent against the site first.

If a bad or malformed record, or a site that cannot be read, blocks
`mise run docs:verify-current`, list the records and mark the offending one
inactive:

~~~~ sh
gh api 'repos/fedify-dev/drfed/deployments?environment=docs-release'
gh api -X POST repos/fedify-dev/drfed/deployments/<id>/statuses \
  -f state=inactive
~~~~

Use `environment=docs-canary` for the canary site.  The previous successful
record is then used.  To keep an unresolved deployment that is known to be
served instead, post `-f state=success` in the same way.

### DNS

The `drfed.org` zone is on Cloudflare.

 -  `drfed.org`: A records `185.199.108.153`, `185.199.109.153`,
    `185.199.110.153`, `185.199.111.153` and AAAA records
    `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`,
    `2606:50c0:8003::153`, all *DNS only* (not proxied).  GitHub Pages serves
    TLS itself and must see its own addresses to issue the certificate.
    Turn on *Enforce HTTPS* once the certificate is issued.
 -  `canary.drfed.org`: CNAME to `drfed-docs.pages.dev`, created by Cloudflare.

### Verification

~~~~ sh
curl -sI https://canary.drfed.org/installation/manual-installation | head -1
curl -sI https://canary.drfed.org/changelog | head -1
curl -sI https://drfed.org/installation/manual-installation | head -1
curl -sI http://drfed.org/ | grep -i '^location'
~~~~

Each extensionless path returns 200, and plain HTTP redirects to HTTPS.  Check
in a browser that opening a *.html* URL ends on the extensionless address,
that refreshing a nested page works, and that each site links to the other.
Cloudflare Pages redirects *.html* URLs on the server, while on GitHub Pages
the VitePress router rewrites the address in the browser, so `curl` does not
show it.


One-time migration from the old site
------------------------------------

`drfed.org` is currently served by Cloudflare Pages from
[fedify-dev/drfed.org].  Do these in order after a release tag has been
deployed to GitHub Pages.  That needs a new tag pushed after this change
lands: re-running the 0.1.0 run uses that commit's workflow, which has no
documentation jobs.  Until the custom domain is set in step 2, the site at
`https://fedify-dev.github.io/drfed/` looks broken because the site has no
base path; this is expected.

1.  In the Cloudflare dashboard, *Workers & Pages*, confirm which project has
    `drfed.org` as a custom domain (expected: `drfed-org`) and how it builds.
    Use that project in step 3.
2.  In the repository *Settings* → *Pages* → *Custom domain*, enter
    `drfed.org` and save.  The DNS check fails until step 4.
3.  In that Cloudflare project, *Custom domains* → `drfed.org` →
    *Remove domain*, then delete its `drfed.org` CNAME record from the zone.
4.  Add the A and AAAA records listed under *DNS*, *DNS only*.
5.  Wait for the DNS check and the certificate (up to 24 hours), then turn on
    *Enforce HTTPS*.
6.  Run the verification commands above and check the navigation link, the
    changelog page, and the newsletter form.
7.  After about a week, archive `fedify-dev/drfed.org`, then delete the old
    Cloudflare project.

To roll back before step 7, add `drfed.org` back as a custom domain of the old
Cloudflare project first, then remove the A and AAAA records.

Remove this section once the migration is complete.

[fedify-dev/drfed.org]: https://github.com/fedify-dev/drfed.org
