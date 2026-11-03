Container image
===============

The official image `ghcr.io/fedify-dev/drfed` contains all four DrFed
commands: `drfed-server`, `drfed-account`, `drfed-migrate`, and `drfed-web`.
It runs on `linux/amd64` and `linux/arm64`, and needs no Node.js on the host.

This page describes the image itself.  For the complete steps with a container
engine, see:

 -  [Docker], with Docker Compose.
 -  [Podman], with `podman compose`.
 -  [Other container tools], with a Compose implementation, a Docker-compatible
    command line, or a configuration of their own.

[Docker]: /installation/container/docker
[Podman]: /installation/container/podman
[Other container tools]: /installation/container/other


Commands
--------

The image runs `drfed-server` by default.  Arguments that start with `-` are
passed to `drfed-server`, and any other command runs as given, so
`drfed-migrate --check` as the container command runs `drfed-migrate`.

The image runs as the unprivileged `node` user (UID 1000).  DrFed handles
`SIGTERM` and finishes shutting down within 10 seconds, so give the container a
longer stop timeout than that; the Compose examples use 20 seconds.


Configuration in containers
---------------------------

Configure the container with the same `DRFED_*` environment variables,
command-line options, and TOML file as any other installation; see
[Configuration].  The usual precedence applies: command-line options, then
environment variables, then the TOML file, then defaults.

Set `DRFED_ROOT_ORIGIN` to the origin that browsers and other servers use to
reach DrFed, not the address the container listens on.  The image sets
`DRFED_CONTAINER=1`, which only changes the default listening host of
`drfed-server` and `drfed-web` to `0.0.0.0`, keeping ports 8888 and 3000.
`--print-config` reports it as a default, and any configured `server.listen`
or `web.listen` replaces it.  The image ships no TOML file; select your own
with `DRFED_CONFIG` or `--config` and mount it into the container.

[Configuration]: /manual/configuration


Data
----

The default PGlite data directory is */var/lib/drfed/data*, inside the
*/var/lib/drfed* volume.  The image places it there through `XDG_DATA_HOME`
rather than `DRFED_DATA_PATH`, so setting `DRFED_POSTGRES_URL` alone switches to
PostgreSQL.

The `node` user owns */var/lib/drfed*.  A new named volume takes that ownership
when it is first mounted.  If you bind-mount a host directory instead, make it
writable by UID 1000.

### PGlite: one process at a time

Only one process can open a PGlite data directory.  While the server runs,
another command on the same volume fails immediately with exit code 1:

~~~~
Error: locked: The PGlite data directory is already in use by another owner.
~~~~

Running the command in the server container does not avoid this.  Create the
first account before starting the server, and stop the server for later
maintenance.  For long-running or shared deployments, use PostgreSQL instead.


Exposing DrFed to the fediverse
-------------------------------

Publishing the container port is enough for local testing at
`http://drfed.localhost:8888`, but not for federation with remote servers.
Each instance is a subdomain of the root origin, so a public deployment needs:

 -  `DRFED_ROOT_ORIGIN` set to its public origin, such as
    `https://drfed.example.com`.
 -  Wildcard DNS for `*.drfed.example.com` as well as `drfed.example.com`.
 -  HTTPS for both, usually from a reverse proxy.
 -  A reverse proxy that forwards the original `Host` header, because DrFed
    routes requests by the host they arrive on.
 -  A mail transport for login mail instead of `DRFED_MAIL_LOG_CONTENT`.

For example, with [Caddy] and on-demand TLS for instance subdomains:

~~~~
drfed.example.com, *.drfed.example.com {
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:8888
}
~~~~

Caddy forwards the original `Host` header by default.  Configure an
[on-demand TLS `ask` endpoint] or use a wildcard certificate through a DNS
challenge.

[Caddy]: https://caddyserver.com/
[on-demand TLS `ask` endpoint]: https://caddyserver.com/docs/automatic-https#on-demand-tls


Tags and provenance
-------------------

Each release is published as an OCI image index for `linux/amd64` and
`linux/arm64` under these tags:

 -  `X.Y.Z` for every release, such as `0.2.0`.  These tags never move.  Use
    them in deployments.
 -  `latest` for the newest stable release.
 -  `next` for the newest prerelease, such as `0.3.0-rc.1`.
 -  `dev` for the newest development build from the `main` branch, which is
    also tagged with its version, such as `0.3.0-dev.123`.

The image is built from the same package tarballs that are published to npm.
Its OCI annotations record the source repository, version, Git revision,
license, base image, and the integrity of each package tarball.  Inspect them
with an OCI registry client such as [Skopeo] or [crane]:

~~~~ sh
skopeo inspect --raw docker://ghcr.io/fedify-dev/drfed:latest
crane manifest ghcr.io/fedify-dev/drfed:latest
~~~~

Every image index also carries a signed build provenance attestation.  Verify
it with the [GitHub CLI]:

~~~~ sh
gh attestation verify oci://ghcr.io/fedify-dev/drfed:latest \
  --repo fedify-dev/drfed
~~~~

The image's build file is *docker/Containerfile* in the repository.

[Skopeo]: https://github.com/containers/skopeo
[crane]: https://github.com/google/go-containerregistry/tree/main/cmd/crane
[GitHub CLI]: https://cli.github.com/
