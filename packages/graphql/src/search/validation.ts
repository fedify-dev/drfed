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

import type { Expression } from "./expression.ts";

export const maxQueryBytes = 4096;
export const maxExpressionDepth = 32;
const encoder = new TextEncoder();

function isAbsoluteIri(value: string): boolean {
  // Like the document validator, reject invalid characters and escapes
  // before using the URL parser. Use it only as a check, not to rewrite IRIs.
  return (
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) &&
    value.isWellFormed() &&
    // oxlint-disable-next-line no-control-regex -- IRIs cannot contain controls.
    !/[\s\x00-\x1f\x7f-\x9f<>"{}|\\^`]|%(?![\da-f]{2})/iu.test(value) &&
    URL.canParse(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkLiteral(
  operator: unknown,
  kind: unknown,
  value: string,
): string | undefined {
  switch (operator) {
    case "eq":
      break;
    case "contains":
      if (kind !== "string") return "Expected a string literal for ~=";
      break;
    case "lt":
    case "le":
    case "gt":
    case "ge":
      if (kind !== "time") return "Expected a TIME literal for ordering";
      break;
    default:
      return "Unknown comparison operator";
  }
  switch (kind) {
    case "string":
      return undefined;
    case "iri":
      return isAbsoluteIri(value)
        ? undefined
        : "Expected an absolute IRI literal";
    case "time":
      try {
        if (Temporal.Instant.from(value).toString() === value) return undefined;
      } catch {
        // Invalid instants and noncanonical spellings share a diagnostic.
      }
      return "Expected a normalized UTC TIME literal";
    default:
      return "Unknown comparison literal kind";
  }
}

/**
 * Validates a parsed or externally supplied search AST. Its budget counts
 * each visited node and each string occurrence, even if a subtree is shared.
 * @returns The validated expression or a diagnostic.
 */
export function validateSearchExpression(
  value: unknown,
): { ok: true; expression: Expression } | { ok: false; error: string } {
  let remaining = maxQueryBytes;
  const sizeError = `Search expression exceeds its ${maxQueryBytes}-byte budget`;
  const spend = (text: string) =>
    text.length <= remaining &&
    (remaining -= encoder.encode(text).byteLength) >= 0;

  function check(node: unknown, depth: number): string | undefined {
    if (depth > maxExpressionDepth) {
      return `Search expression depth exceeds ${maxExpressionDepth}`;
    }
    remaining -= 1;
    if (remaining < 0) return sizeError;
    if (!isRecord(node)) return "Expected a search expression node";
    switch (node.kind) {
      case "and":
      case "or":
        return check(node.left, depth + 1) ?? check(node.right, depth + 1);
      case "not":
        return check(node.operand, depth + 1);
      case "comparison": {
        if (!Array.isArray(node.path) || node.path.length === 0) {
          return "Expected a nonempty property path";
        }
        for (const segment of node.path as unknown[]) {
          if (typeof segment !== "string") {
            return "Expected an absolute IRI in the property path";
          }
          if (!spend(segment)) return sizeError;
          if (!isAbsoluteIri(segment)) {
            return "Expected an absolute IRI in the property path";
          }
        }
        const literal = node.value;
        if (!isRecord(literal) || typeof literal.value !== "string") {
          return "Expected a typed comparison literal";
        }
        if (!spend(literal.value)) return sizeError;
        return checkLiteral(node.operator, literal.kind, literal.value);
      }
      default:
        return "Unknown search expression kind";
    }
  }
  const error = check(value, 1);
  return error === undefined
    ? { ok: true, expression: value as Expression }
    : { ok: false, error };
}
