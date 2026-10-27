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

# Back up a PGlite data volume to drfed-data.tgz.  Run it next to the Compose
# file; the documentation includes the region below verbatim.
set -e

# region backup
# Start the server again afterwards only if it is running now, and replace an
# earlier drfed-data.tgz only with a complete backup.
running=$(docker compose ps --status running --quiet drfed)
finish() {
  if [ -n "$running" ]; then
    docker compose up -d drfed
  fi
  rm -f drfed-data.tgz.partial
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
docker compose stop drfed
docker compose run --rm -T drfed \
  tar czf - -C /var/lib/drfed . > drfed-data.tgz.partial
mv drfed-data.tgz.partial drfed-data.tgz
# endregion backup
