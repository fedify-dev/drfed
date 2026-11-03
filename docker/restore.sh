#!/bin/sh
# DrFed: A web-based platform for developing and debugging ActivityPub apps
# Copyright (C) 2026 DrFed team
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

# Restore drfed-data.tgz into a new, empty PGlite data volume.  Run it next to
# the Compose file.  The documentation shows, and the image tests run, only the
# region below, so it must stop on the first failure by itself.

# region restore
set -e
docker compose run --rm -T drfed \
  tar xzf - -C /var/lib/drfed < drfed-data.tgz
docker compose up -d drfed
# endregion restore
