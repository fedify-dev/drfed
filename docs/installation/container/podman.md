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

On Ubuntu 26.04, rootless Podman may fail to stop a container with
`rootless netns: kill network process: permission denied`, because the AppArmor
profile for pasta refuses Podman's signal; see [Launchpad bug #2154379].  Until
a fixed package is released, add the rule from that report to the profile and
reload it:

~~~~ sh
sudo sed --in-place '$ i\  signal (receive) set=(term) peer=podman,' /etc/apparmor.d/usr.bin.pasta
sudo apparmor_parser --replace /etc/apparmor.d/usr.bin.pasta
~~~~

Podman 4.9, the version in Ubuntu 24.04, reports a container's network by name
where `docker-compose` expects its ID.  `docker-compose` then treats a running
dependency as out of date, so `podman compose run` replaces the PostgreSQL
container, and the server's database connections can stall for 20 seconds or
more.  Use Podman 5.7, the version CI tests, or add `--no-deps` to
`podman compose run` while PostgreSQL is running.

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

[Launchpad bug #2154379]: https://bugs.launchpad.net/ubuntu/+source/passt/+bug/2154379
[`podman compose`]: https://docs.podman.io/en/latest/markdown/podman-compose.1.html

<!--@include: ./parts/compose-workflow.md-->
