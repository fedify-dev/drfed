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

/** Ordered full property IRIs; traversal does not follow IRI references. */
export type PropertyPath = readonly [string, ...string[]];

export type StringLiteral = { readonly kind: "string"; readonly value: string };
export type IriLiteral = { readonly kind: "iri"; readonly value: string };
/** A validated document timestamp serialized in UTC, not the search cutoff. */
export type TimeLiteral = { readonly kind: "time"; readonly value: string };
export type Literal = StringLiteral | IriLiteral | TimeLiteral;

export type Comparison = {
  readonly kind: "comparison";
  readonly path: PropertyPath;
} & (
  | { readonly operator: "eq"; readonly value: Literal }
  | { readonly operator: "contains"; readonly value: StringLiteral }
  | {
      readonly operator: "lt" | "le" | "gt" | "ge";
      readonly value: TimeLiteral;
    }
);

export type Expression =
  | Comparison
  | {
      readonly kind: "and";
      readonly left: Expression;
      readonly right: Expression;
    }
  | {
      readonly kind: "or";
      readonly left: Expression;
      readonly right: Expression;
    }
  | { readonly kind: "not"; readonly operand: Expression };

declare const checkedExpression: unique symbol;

/** An immutable AST from a successful full query parse, not a JSON wire type. */
export type CheckedExpression = Expression & {
  readonly [checkedExpression]: true;
};
