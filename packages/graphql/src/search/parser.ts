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

import {
  type Parser,
  choice,
  endOfInput,
  fail,
  many,
  optionalWhitespace,
  recursiveParser,
  sequenceOf,
  str,
  succeedWith,
} from "arcsecond";

import type {
  Comparison,
  Expression,
  PropertyPath,
  TimeLiteral,
} from "./expression.ts";
import {
  iri,
  keyword,
  lexeme,
  orderingOperator,
  punctuation,
  quotedString,
} from "./lexemes.ts";

const segment = sequenceOf([str("."), iri]).map(([, { value }]) => value);

/**
 * Parses a nonempty path of adjacent `.<IRI>` segments, followed by optional
 * whitespace. Preserves the IRI spelling; this rule does not resolve aliases
 * or validate IRI semantics.
 */
export const propertyPath: Parser<PropertyPath> = lexeme(
  sequenceOf([segment, many(segment)]).map(
    ([first, rest]): PropertyPath => [first, ...rest],
  ),
);

const timestamp =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

const timeLiteral = sequenceOf([keyword("TIME"), quotedString])
  .map(([, { value }]) => value)
  .chain<TimeLiteral>((value) => {
    if (value === undefined || !timestamp.test(value)) {
      return fail("Expected a timestamp with an explicit UTC offset");
    }
    try {
      return succeedWith({
        kind: "time",
        value: Temporal.Instant.from(value).toString(),
      });
    } catch {
      return fail("Invalid timestamp");
    }
  });

const comparisonOperator = choice([
  punctuation("=").map(() => "eq" as const),
  punctuation("~=").map(() => "contains" as const),
  orderingOperator,
]);
const equalityLiteral = choice([quotedString, lexeme(iri), timeLiteral]);

/** Parses a single comparison, enforcing its operator's literal type. */
export const comparison: Parser<Comparison> = sequenceOf([
  propertyPath,
  comparisonOperator,
]).chain<Comparison>((head) => {
  if (head === undefined) return fail("Expected a property path and operator");
  const [path, operator] = head;
  switch (operator) {
    case "eq":
      return equalityLiteral.map((value) => ({
        kind: "comparison",
        path,
        operator,
        value,
      }));
    case "contains":
      return quotedString.map((value) => ({
        kind: "comparison",
        path,
        operator,
        value,
      }));
    default:
      return timeLiteral.map((value) => ({
        kind: "comparison",
        path,
        operator,
        value,
      }));
  }
});

const expression: Parser<Expression> = recursiveParser(() => disjunction);
const unary: Parser<Expression> = recursiveParser(() =>
  choice([
    sequenceOf([keyword("NOT"), unary]).map<Expression>(([, operand]) => ({
      kind: "not",
      operand,
    })),
    sequenceOf([punctuation("("), expression, punctuation(")")]).map(
      ([, inner]) => inner,
    ),
    comparison,
  ]),
);

function binary(
  kind: "and" | "or",
  operand: Parser<Expression>,
): Parser<Expression> {
  const operator = keyword(kind === "and" ? "AND" : "OR");
  const tail = sequenceOf([operator, operand]).map(([, right]) => right);
  return sequenceOf([operand, many(tail)]).map(([first, rest]) =>
    rest.reduce<Expression>((left, right) => ({ kind, left, right }), first),
  );
}

const conjunction = binary("and", unary);
const disjunction = binary("or", conjunction);

/** Parses an entire query with precedence `NOT`, then `AND`, then `OR`. */
export const queryParser: Parser<Expression> = sequenceOf([
  optionalWhitespace,
  expression,
  endOfInput,
]).map(([, result]) => result);
