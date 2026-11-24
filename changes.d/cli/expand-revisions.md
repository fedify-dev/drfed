---
links:
  '#187': https://github.com/fedify-dev/drfed/issues/187
---
 -  Added `drfed-migrate --expand-revisions`, which applies pending
    migrations, then records the JSON-LD expansion of every revision stored
    without one, loading the remote contexts its document names.  Run it once
    after upgrading; running it again records nothing new.  It cannot be
    combined with `--check`.  [[#187] by Hyeonseo Kim]
