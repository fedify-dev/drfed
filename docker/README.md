Container image
===============

*Containerfile* builds the official image `ghcr.io/fedify-dev/drfed` from the
five package tarballs; *Dockerfile* is a symbolic link to it.  The Compose files
and the backup and restore scripts are the examples that the
[container installation guide] includes, and `mise run test:image` runs them
with Docker and Podman against the image under test together with
*compose.ci.yaml*.  The Podman guide shows the backup and restore scripts with
`podman` in place of `docker`, which is also how the Podman tests run them.
See the “Container images” section of [*CONTRIBUTING.md*](../CONTRIBUTING.md)
for building and releasing the image.

[container installation guide]: https://drfed.org/installation/container/
