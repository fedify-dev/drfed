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

import { type SQL, type SQLWrapper, and, not, or, sql } from "drizzle-orm";

import type {
  Comparison,
  Expression,
  IriLiteral,
  PropertyPath,
  StringLiteral,
  TimeLiteral,
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
  // Bind the serialized array as text so postgres.js doesn't JSON-encode it again.
  return sql`exists (
    with recursive search_path(keys) as (values (${JSON.stringify(path)}::text::jsonb)),
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

// Shared by equality and substring matching. Language-tagged strings have
// no @type; other typed values are not searchable as strings.
const stringValue = sql`jsonb_typeof(found.node -> '@value') = 'string'
  and (not (found.node ? '@type')
    or found.node ->> '@type' = 'http://www.w3.org/2001/XMLSchema#string')`;

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
      : sql`${stringValue} and found.node -> '@value' = ${literal}`;
  return existsAtPath(document, path, predicate);
}

/**
 * Compiles a case-insensitive literal substring comparison.
 * @returns A predicate that matches any string at the exact path.
 */
export function compileSubstring(
  expression: Extract<Comparison, { operator: "contains" }>,
  document: SQLWrapper,
): SQL {
  const needle = expression.value.value.replace(/[!%_]/gu, "!$&");
  return existsAtPath(
    document,
    expression.path,
    sql`${stringValue} and found.node ->> '@value' ilike ${`%${needle}%`} escape '!'`,
  );
}

const timeOperators = {
  eq: sql`=`,
  lt: sql`<`,
  le: sql`<=`,
  gt: sql`>`,
  ge: sql`>=`,
};

// Match the query language's offset-bearing date-time syntax. Keep the
// fraction separate: PostgreSQL timestamps round it to microseconds.
const timestampParts = String.raw`^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:\.([0-9]{1,9}))?(?:Z|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))$`;

function compileTime(
  path: PropertyPath,
  operator: keyof typeof timeOperators,
  value: TimeLiteral,
  document: SQLWrapper,
): SQL {
  const nanoseconds = Temporal.Instant.from(value.value).epochNanoseconds;
  return existsAtPath(
    document,
    path,
    sql`found.node ->> '@type' in (
      'http://www.w3.org/2001/XMLSchema#dateTime',
      'http://www.w3.org/2001/XMLSchema#dateTimeStamp'
    )
    and jsonb_typeof(found.node -> '@value') = 'string'
    and exists (
      select 1
      from regexp_match(found.node ->> '@value', ${timestampParts}) as stamp(parts)
      cross join lateral (
        -- Build from the first of the month so invalid dates cannot throw.
        -- ISO year 0000 is PostgreSQL's 1 BC.
        select make_date(
          coalesce(nullif(parts[1]::int, 0), -1), parts[2]::int, 1
        ) + (parts[3]::int - 1) as day
      ) as calendar
      where extract(day from calendar.day) = parts[3]::int
        and (
          (
            (calendar.day - date '1970-01-01')::numeric * 86400
            + parts[4]::int * 3600 + parts[5]::int * 60 + parts[6]::int
            - case parts[8]
                when '+' then parts[9]::int * 3600 + parts[10]::int * 60
                when '-' then -(parts[9]::int * 3600 + parts[10]::int * 60)
                else 0
              end
          ) * 1000000000
          + rpad(coalesce(parts[7], ''), 9, '0')::numeric
        ) ${timeOperators[operator]} ${nanoseconds.toString()}::numeric
    )`,
  );
}

function compileComparison(expression: Comparison, document: SQLWrapper): SQL {
  const { operator, path, value } = expression;
  if (operator === "contains") return compileSubstring(expression, document);
  if (operator === "eq") {
    return value.kind === "time"
      ? compileTime(path, operator, value, document)
      : compileStringOrIriEquality(
          { kind: "comparison", path, operator, value },
          document,
        );
  }
  return compileTime(path, operator, value, document);
}

/**
 * Compiles a checked search expression over one expanded JSON-LD document.
 * Each comparison has its own existential match, even inside one conjunction.
 * @returns A SQL predicate independent of revision selection and authorization.
 */
export function compileExpression(
  expression: Expression,
  document: SQLWrapper,
): SQL {
  const compile = (child: Expression) => compileExpression(child, document);
  // oxlint-disable-next-line default-case -- Keep expression handling exhaustive.
  switch (expression.kind) {
    case "comparison":
      return compileComparison(expression, document);
    case "and":
      return and(compile(expression.left), compile(expression.right))!;
    case "or":
      return or(compile(expression.left), compile(expression.right))!;
    case "not":
      return not(compile(expression.operand));
  }
}
