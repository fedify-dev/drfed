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
  Parser,
  choice,
  endOfInput,
  fail,
  many,
  optionalWhitespace,
  recursiveParser,
  sequenceOf,
  str,
  succeedWith,
  updateData,
  updateError,
  updateResult,
} from "arcsecond";

import type {
  CheckedExpression,
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

const maxExpressionDepth = 32;
const maxQueryBytes = 4096;

function isAbsoluteIri(value: string): boolean {
  return (
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) &&
    value.isWellFormed() &&
    // oxlint-disable-next-line no-control-regex -- IRIs cannot contain controls.
    !/[\s\x00-\x1f\x7f-\x9f<>"{}|\\^`]|%(?![\da-f]{2})/iu.test(value) &&
    URL.canParse(value)
  );
}

const segment = sequenceOf([str("."), iri]).map(([, { value }]) => value);

/**
 * Parses a nonempty path of adjacent `.<IRI>` segments, followed by optional
 * whitespace. Checks absolute IRIs without rewriting them or resolving aliases.
 */
export const propertyPath: Parser<PropertyPath> = lexeme(
  sequenceOf([segment, many(segment)]).chain<PropertyPath>((parts) => {
    if (parts === undefined) return fail("Expected a property path");
    const [first, rest] = parts;
    const path: PropertyPath = [first, ...rest];
    return path.every(isAbsoluteIri)
      ? succeedWith(path)
      : fail("Expected an absolute IRI in the property path");
  }),
);

// Reject leap-second spellings rather than letting Temporal clamp them to :59.
const timestamp =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

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
const equalityLiteral = choice([quotedString, lexeme(iri), timeLiteral]).chain(
  (value) =>
    value === undefined || (value.kind === "iri" && !isAbsoluteIri(value.value))
      ? fail("Expected an absolute IRI literal")
      : succeedWith(value),
);

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

interface Nesting {
  depth: number;
  exceeded: boolean;
}

function nested(parser: Parser<Expression>): Parser<Expression> {
  return new Parser((state) => {
    if (state.isError) return state;
    const nesting = state.data as Nesting;
    if (nesting.depth >= maxExpressionDepth) {
      nesting.exceeded = true;
      return fail("Search expression nesting limit exceeded").p(state);
    }
    nesting.depth += 1;
    try {
      return parser.p(state);
    } finally {
      nesting.depth -= 1;
    }
  });
}

const expression: Parser<Expression> = recursiveParser(() => disjunction);
const unary: Parser<Expression> = recursiveParser(() =>
  choice([
    sequenceOf([keyword("NOT"), nested(unary)]).map<Expression>(
      ([, operand]) => ({ kind: "not", operand }),
    ),
    sequenceOf([punctuation("("), nested(expression), punctuation(")")]).map(
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

const completeQuery = sequenceOf([
  optionalWhitespace,
  expression,
  endOfInput,
]).map(([, result]) => result);

// Walk only to the depth limit, freezing the parser-owned nodes as we go.
function freezeWithinDepth(node: Expression, remaining: number): boolean {
  if (remaining === 0) return false;
  Object.freeze(node);
  // A flat chain also grows AST depth because binary operators associate left.
  // oxlint-disable-next-line default-case -- Keep the AST walk exhaustive.
  switch (node.kind) {
    case "comparison":
      Object.freeze(node.path);
      Object.freeze(node.value);
      return true;
    case "not":
      return freezeWithinDepth(node.operand, remaining - 1);
    case "and":
    case "or":
      return (
        freezeWithinDepth(node.left, remaining - 1) &&
        freezeWithinDepth(node.right, remaining - 1)
      );
  }
}

/** Parses a complete query with bounded input, syntax nesting, and AST depth. */
export const queryParser: Parser<CheckedExpression> = new Parser((state) => {
  if (state.isError) return state;
  if (state.dataView.byteLength > maxQueryBytes) {
    return updateError(
      state,
      `Search query exceeds ${maxQueryBytes} UTF-8 bytes`,
    );
  }
  const nesting: Nesting = { depth: 0, exceeded: false };
  const result = completeQuery.p(updateData(state, nesting));
  // Arcsecond alternatives can backtrack over a nesting error.
  if (nesting.exceeded) {
    return updateError(
      { ...state, index: result.index },
      `Search query nesting exceeds ${maxExpressionDepth}`,
    );
  }
  if (result.isError) {
    return updateError({ ...state, index: result.index }, result.error);
  }
  if (!freezeWithinDepth(result.result, maxExpressionDepth)) {
    return updateError(
      { ...state, index: result.index },
      `Search expression depth exceeds ${maxExpressionDepth}`,
    );
  }
  // Only the full parser brands the tree, after all bounds and rules pass.
  return updateResult(result, result.result as CheckedExpression);
});
