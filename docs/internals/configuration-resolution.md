Configuration resolution
========================

The CLI commands share one setting registry and resolve only the bindings they
consume. This page is for contributors adding commands or settings. See
[configuration](../manual/configuration.md) for TOML examples, precedence and
operator diagnostics.

`@drfed/drfed/configuration` supplies the common setting registry, strict TOML
structure, and isolated [Optique environment] and [configuration] contexts.
Bindings preserve `CLI > DRFED_* > TOML > default`, including `false` and
empty arrays. Array sources replace each other. Each result carries its source
and, for TOML values, the absolute configuration file path; provenance maps
contain no setting values.

Commands must check required values after resolution. An absent optional
setting has a default-sourced result whose `value` is `undefined`; wrapping
a binding in `optional()` can hide invalid environment values and should be
avoided. Bind only the settings a command consumes, so unused environment
values remain unread. The entire TOML file is still checked for unknown keys
and wrong types. `configurationPath()` resolves CLI and environment paths
against the supplied working directory and TOML paths against the file's
directory. The loader reads only an explicitly selected file and fails if
that file is missing. It neither searches for configuration nor loads *.env*.

`@drfed/drfed/database-settings` exposes `resolveDatabaseSettings()` for
database backend and connection settings, returning plain runtime settings
and source-only metadata for ignored fields. Migration and runtime connection
settings must agree; see
[database lifecycle](database-lifecycle.md#facade-integration). The
[HTTP runtime](http-serving.md) consumes the resolved origins and bindings.

[Optique environment]: https://optique.dev/integrations/env.md
[configuration]: https://optique.dev/integrations/config.md
