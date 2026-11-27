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

import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

import type {
  Comparison,
  IriLiteral,
  PropertyPath,
  StringLiteral,
} from "./expression.ts";

function elements(value: SQLWrapper): SQL {
  return sql`jsonb_array_elements(
    case when jsonb_typeof(${value}) = 'array' then ${value} else '[]'::jsonb end
  )`;
}

function existsAtPath(
  document: SQLWrapper,
  path: PropertyPath,
  predicate: SQL,
): SQL {
  // Start at every root node, then advance exactly one property per step.
  // Walk inline node objects only; never dereference @id or enter @value.
  return sql`exists (
    with recursive search_path(keys) as (values (${JSON.stringify(path)}::jsonb)),
    search_nodes(depth, node) as (
      select 0, root.node from ${elements(document)} as root(node)
      union all
      select current_node.depth + 1, child.node
      from search_nodes as current_node
      cross join search_path
      cross join lateral ${elements(sql`
        current_node.node -> (search_path.keys ->> current_node.depth)
      `)} as child(node)
      where current_node.depth < ${path.length}
        and jsonb_typeof(current_node.node) = 'object'
        and not (current_node.node ? '@value')
    )
    select 1 from search_nodes as found
    where found.depth = ${path.length} and (${predicate})
  )`;
}

/**
 * Compiles string or IRI equality over a stored expanded JSON-LD document.
 * The comparison has already been checked by the caller. This does not
 * authorize access or select which revision to search.
 * @returns A predicate that matches if any value at the exact path is equal.
 */
export function compileStringOrIriEquality(
  expression: Extract<Comparison, { operator: "eq" }> & {
    value: StringLiteral | IriLiteral;
  },
  document: SQLWrapper,
): SQL {
  const { path, value } = expression;
  const literal = sql`to_jsonb(${value.value}::text)`;
  const predicate =
    value.kind === "iri"
      ? sql`found.node -> '@id' = ${literal}`
      : sql`found.node -> '@value' = ${literal}
      and (not (found.node ? '@type')
        or found.node ->> '@type' = 'http://www.w3.org/2001/XMLSchema#string')`;
  return existsAtPath(document, path, predicate);
}
