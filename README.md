DrFed
=====

[![GitHub Actions][GitHub Actions badge]][GitHub Actions]
[![License: GPL-3.0-only][AGPLv3 badge]][AGPLv3]

DrFed is a web-based platform for developing and debugging [ActivityPub]
implementations, built by the team behind [Fedify]. It brings together the
tools you need to diagnose federation failures in one place: fetch and inspect
any ActivityPub object, monitor incoming activities in real time, step through
HTTP signature construction and verification, validate WebFinger and NodeInfo
responses, explore JSON-LD compaction and expansion, and send test activities
to any inbox. The goal is to make it straightforward to answer the question
“why doesn't my server federate with X?”—by showing you exactly which stage
broke, whether that's DNS, TLS, HTTP, signatures, or JSON-LD processing.

[GitHub Actions badge]: https://github.com/fedify-dev/drfed/actions/workflows/main.yaml/badge.svg
[GitHub Actions]: https://github.com/fedify-dev/drfed/actions/workflows/main.yaml
[AGPLv3 badge]: https://img.shields.io/github/license/fedify-dev/drfed
[AGPLv3]: https://www.gnu.org/licenses/agpl-3.0.html
[ActivityPub]: https://www.w3.org/TR/activitypub/
[Fedify]: https://fedify.dev/


Documentation
-------------

The documentation site lives in *docs/* and uses [VitePress]. After
`mise install`, run `mise run dev:docs` to start it locally. Run
`mise run build:docs` to build the static site and `mise run preview:docs` to
preview the result.

[VitePress]: https://vitepress.dev/
