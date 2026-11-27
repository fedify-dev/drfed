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
  optionalWhitespace,
  regex,
  sequenceOf,
  str,
} from "arcsecond";

import type { IriLiteral, StringLiteral } from "./expression.ts";

/** @returns A parser that preserves the value and consumes trailing whitespace. */
export function lexeme<T>(parser: Parser<T>): Parser<T> {
  return sequenceOf([parser, optionalWhitespace]).map(([value]) => value);
}

export const punctuation = (
  text: "." | "(" | ")" | "=" | "~=",
): Parser<string> => lexeme(str(text));

export const keyword = (word: "AND" | "OR" | "NOT" | "TIME"): Parser<string> =>
  lexeme(regex(new RegExp(`^${word}(?![\\w-])`, "iu")));

// Only recognizes IRI spelling; validate the value in the grammar. Keep this
// unwrapped so the path rule can require "." and "<...>" to be adjacent.
export const iri: Parser<IriLiteral> = regex(
  /^<[A-Za-z][A-Za-z0-9+.-]*:[^<>\s]*>/u,
).map((text) => ({ kind: "iri", value: text.slice(1, -1) }));

export const quotedString: Parser<StringLiteral> = lexeme(
  regex(
    // oxlint-disable-next-line no-control-regex -- JSON forbids unescaped U+0000–U+001F.
    /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/u,
  ).map((text) => ({ kind: "string", value: JSON.parse(text) as string })),
);

export const orderingOperator: Parser<"lt" | "le" | "gt" | "ge"> = lexeme(
  choice([
    str("<=").map(() => "le" as const),
    str(">=").map(() => "ge" as const),
    str("<").map(() => "lt" as const),
    str(">").map(() => "gt" as const),
  ]),
);
