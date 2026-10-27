Container image
===============

*Containerfile* builds the official image `ghcr.io/fedify-dev/drfed` from the
five package tarballs; *Dockerfile* is a symbolic link to it.  The Compose files
and the backup and restore scripts are the examples that the
[Docker installation guide] includes, and `mise run image:test` runs them
against the image under test together with *compose.ci.yaml*.  See the
“Container images” section of [*CONTRIBUTING.md*](../CONTRIBUTING.md) for
building and releasing the image.

[Docker installation guide]: https://drfed.org/installation/docker
