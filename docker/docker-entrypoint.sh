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

# Run drfed-server by default, treat leading options as drfed-server options,
# and run any other command as given.  exec makes the command PID 1, so it
# receives the stop signal directly.
set -e
if [ "$#" -eq 0 ]; then
  set -- drfed-server
elif [ "${1#-}" != "$1" ]; then
  set -- drfed-server "$@"
fi
exec "$@"
