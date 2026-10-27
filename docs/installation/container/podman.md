---
containerEngine: podman
---

Podman
======

These steps run the [container image] with [Podman] and `podman compose`.  CI
runs the Compose examples, and the backup and restore commands exactly as shown
here, against every image with Podman.

[container image]: /installation/container/
[Podman]: https://podman.io/


Before you start
----------------

On macOS and Windows, Podman runs containers in a virtual machine.  Create and
start it once:

~~~~ sh
podman machine init
podman machine start
~~~~

On Linux, `podman compose` talks to the Podman API socket, so start it for
your user:

~~~~ sh
systemctl --user start podman.socket
~~~~

`podman compose` runs an external Compose provider: `docker-compose` if it is
installed, otherwise `podman-compose`.  CI tests these steps with
`docker-compose`.  To choose another provider, set `PODMAN_COMPOSE_PROVIDER` or
`compose_providers` in *containers.conf*; set
`PODMAN_COMPOSE_WARNING_LOGS=false` to hide the notice it prints for each
command.  See [`podman compose`].

If `DOCKER_HOST` is set, `podman compose` passes it to the provider, which then
uses that engine instead of Podman.  Unset it before running these steps.

Rootless Podman gives a new named volume the image's ownership of
*/var/lib/drfed*, just like Docker, so the Compose files need no
Podman-specific volume options.

[`podman compose`]: https://docs.podman.io/en/latest/markdown/podman-compose.1.html

<!--@include: ./parts/compose-workflow.md-->
