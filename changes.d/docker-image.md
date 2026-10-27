---
links:
  '#135': https://github.com/fedify-dev/drfed/issues/135
---
 -  Published the official container image `ghcr.io/fedify-dev/drfed` for
    `linux/amd64` and `linux/arm64`, with all four commands, along with
    installation guides for Docker, Podman, and other container tools and
    Compose examples for PGlite and PostgreSQL. Inside the image,
    `drfed-server` and `drfed-web` listen on `0.0.0.0` by default; any
    configured listen address still takes precedence. [[#135] by ChanHaeng Lee]
