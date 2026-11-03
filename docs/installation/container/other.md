Other container tools
=====================

The [container image] follows the [OCI Image Format Specification], so tools
that pull and run OCI images can run it.  The OCI specifications define the
image format and a low-level [runtime interface] for runtimes such as runc, not
commands such as `run` or `volume create`, so the steps depend on the tool.
CI tests only [Docker] and [Podman]; with other tools, check these requirements
yourself:

 -  The tool picks the `linux/amd64` or `linux/arm64` image from the
    OCI image index.
 -  */var/lib/drfed* is a volume that UID 1000 can write to.
 -  The container stops with `SIGTERM` and a grace period longer than
    10 seconds.

[container image]: /installation/container/
[OCI Image Format Specification]: https://github.com/opencontainers/image-spec/blob/main/spec.md
[runtime interface]: https://github.com/opencontainers/runtime-spec/blob/main/spec.md
[Docker]: /installation/container/docker
[Podman]: /installation/container/podman


With a Compose implementation
-----------------------------

A tool that implements the [Compose Specification] can use the Compose files
from the [Docker] steps unchanged.  Replace `docker compose` in those steps
with the tool's Compose command.

[Compose Specification]: https://compose-spec.io/


With a Docker-compatible command line
-------------------------------------

The commands below use the `volume create`, `run`, and `logs` commands of the
Docker command line.  They work only with tools that provide the same commands
and options, such as [nerdctl] for containerd.  Replace `<engine>` with the
tool's command and `<image>` with an image tag, such as
`ghcr.io/fedify-dev/drfed:latest` or a fixed `X.Y.Z` release; see
[tags][Tags and provenance].

Create a volume and your account, then start DrFed:

~~~~ sh
<engine> volume create drfed-data
<engine> run --rm -v drfed-data:/var/lib/drfed \
  -e DRFED_ROOT_ORIGIN=http://drfed.localhost:8888 \
  <image> drfed-account create --email alice@example.com --name "Alice"
<engine> run -d --name drfed -v drfed-data:/var/lib/drfed \
  -p 127.0.0.1:8888:8888 --stop-timeout 20 \
  -e DRFED_ROOT_ORIGIN=http://drfed.localhost:8888 \
  -e DRFED_MAIL_LOG_CONTENT=true \
  <image>
~~~~

Open `http://drfed.localhost:8888`, sign in with your email address, and follow
the login link in `<engine> logs drfed`.  Every management command needs the
same volume and `DRFED_*` variables as the server, and with PGlite it needs the
server stopped first; see [PGlite: one process at a time].

[nerdctl]: https://github.com/containerd/nerdctl
[Tags and provenance]: /installation/container/#tags-and-provenance
[PGlite: one process at a time]: /installation/container/#pglite-one-process-at-a-time


Other tools
-----------

Tools without such a command line, such as Kubernetes or an OCI runtime used
directly, need their own configuration.  Carry over the requirements above and
the settings of the [Compose example][Docker]: the image, the volume at
*/var/lib/drfed*, the `DRFED_*` environment variables, port 8888, and the stop
grace period.
