// DrFed: A web-based platform for developing and debugging ActivityPub apps
// Copyright (C) 2026 DrFed team
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import { Link } from "@kobalte/core/link";
import { graphql } from "relay-runtime";
import { createFragment } from "solid-relay";

import type { InstanceSummary_instance$key } from "./__generated__/InstanceSummary_instance.graphql.tsx";

export default function InstanceSummary(props: {
  $instance: InstanceSummary_instance$key;
}) {
  const data = createFragment(
    graphql`
      fragment InstanceSummary_instance on Instance {
        id
        host
      }
    `,
    () => props.$instance,
  );

  return (
    <p>
      {data()?.host}
      <Link href={`/workspace/create/${data()?.id}/actors`}>Create Actors</Link>
    </p>
  );
}
