import {
  canonicalHash,
  compareUnicodeScalars,
  unicodeScalarLength,
  utf8ByteLength,
} from "./canonical.ts";
import { RuntimeError } from "./errors.ts";
import type { AirExpr, JsonValue } from "./ir.ts";

export type RuntimeEnvironment = ReadonlyMap<string, JsonValue>;

function expectNumber(value: JsonValue, operation: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RuntimeError("AX2008", `${operation} requires safe integer operands`);
  }
  return value;
}

function expectBoolean(value: JsonValue, operation: string): boolean {
  if (typeof value !== "boolean") {
    throw new RuntimeError("AX2009", `${operation} requires Boolean operands`);
  }
  return value;
}

function safeIntegerResult(value: number, operation: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RuntimeError(
      "AX2020",
      `${operation} produced a value outside Axiom's safe integer range`,
    );
  }
  return value;
}

function compare(left: JsonValue, right: JsonValue): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return compareUnicodeScalars(left, right);
  }
  throw new RuntimeError("AX2010", "Comparison requires two integers or two strings");
}

function equal(left: JsonValue, right: JsonValue): boolean {
  return canonicalHash(left) === canonicalHash(right);
}

function evaluateBuiltin(name: string, args: readonly JsonValue[]): JsonValue {
  switch (name) {
    case "len": {
      if (args.length !== 1) {
        throw new RuntimeError("AX2011", "len expects one argument");
      }
      const value = args[0];
      if (typeof value === "string") {
        return unicodeScalarLength(value);
      }
      if (Array.isArray(value)) {
        return value.length;
      }
      if (value !== null && typeof value === "object") {
        return Object.keys(value).length;
      }
      throw new RuntimeError("AX2012", "len expects a string, array, or record");
    }
    case "utf8_bytes": {
      if (args.length !== 1 || typeof args[0] !== "string") {
        throw new RuntimeError("AX2022", "utf8_bytes expects one Text argument");
      }
      return utf8ByteLength(args[0]);
    }
    case "contains": {
      if (args.length !== 2) {
        throw new RuntimeError("AX2013", "contains expects two arguments");
      }
      const [container, needle] = args;
      if (typeof container === "string" && typeof needle === "string") {
        return container.includes(needle);
      }
      if (Array.isArray(container)) {
        return container.some((item) => equal(item, needle as JsonValue));
      }
      throw new RuntimeError("AX2014", "contains expects a string/string or array/value pair");
    }
    case "sort": {
      if (args.length !== 1 || !Array.isArray(args[0])) {
        throw new RuntimeError("AX2015", "sort expects one array argument");
      }
      return [...args[0]].sort((a, b) => compare(a, b));
    }
    case "hash": {
      if (args.length !== 1) {
        throw new RuntimeError("AX2016", "hash expects one argument");
      }
      return canonicalHash(args[0] as JsonValue);
    }
    case "min":
    case "max": {
      if (args.length === 0) {
        throw new RuntimeError("AX2017", `${name} expects at least one argument`);
      }
      const values = args.map((value) => expectNumber(value, name));
      return name === "min" ? Math.min(...values) : Math.max(...values);
    }
    default:
      throw new RuntimeError("AX2018", `Unknown deterministic builtin \`${name}\``);
  }
}

export function evaluateExpression(expression: AirExpr, environment: RuntimeEnvironment): JsonValue {
  switch (expression.kind) {
    case "literal":
      return expression.value;
    case "variable": {
      const value = environment.get(expression.name);
      if (value === undefined) {
        throw new RuntimeError("AX2001", `Undefined runtime value \`${expression.name}\``);
      }
      return value;
    }
    case "array":
      return expression.items.map((item) => evaluateExpression(item, environment));
    case "record": {
      const output: Record<string, JsonValue> = {};
      for (const field of expression.fields) {
        Object.defineProperty(output, field.name, {
          value: evaluateExpression(field.value, environment),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return output;
    }
    case "field": {
      const target = evaluateExpression(expression.target, environment);
      if (target === null || Array.isArray(target) || typeof target !== "object") {
        throw new RuntimeError("AX2002", `Cannot read field \`${expression.field}\` from a non-record value`);
      }
      if (!(expression.field in target)) {
        throw new RuntimeError("AX2003", `Record does not contain field \`${expression.field}\``);
      }
      return (target as { readonly [key: string]: JsonValue })[expression.field] as JsonValue;
    }
    case "call": {
      const args = expression.arguments.map((argument) => evaluateExpression(argument, environment));
      return evaluateBuiltin(expression.callee, args);
    }
    case "binary": {
      const left = evaluateExpression(expression.left, environment);
      if (expression.operator === "&&") {
        return expectBoolean(left, "&&")
          ? expectBoolean(evaluateExpression(expression.right, environment), "&&")
          : false;
      }
      if (expression.operator === "||") {
        return expectBoolean(left, "||")
          ? true
          : expectBoolean(evaluateExpression(expression.right, environment), "||");
      }
      const right = evaluateExpression(expression.right, environment);
      switch (expression.operator) {
        case "==":
          return equal(left, right);
        case "!=":
          return !equal(left, right);
        case "<":
          return compare(left, right) < 0;
        case "<=":
          return compare(left, right) <= 0;
        case ">":
          return compare(left, right) > 0;
        case ">=":
          return compare(left, right) >= 0;
        case "+":
          if (typeof left === "string" && typeof right === "string") {
            return left + right;
          }
          return safeIntegerResult(
            expectNumber(left, "+") + expectNumber(right, "+"),
            "+",
          );
        case "-":
          return safeIntegerResult(
            expectNumber(left, "-") - expectNumber(right, "-"),
            "-",
          );
        case "*":
          return safeIntegerResult(
            expectNumber(left, "*") * expectNumber(right, "*"),
            "*",
          );
        case "/": {
          const divisor = expectNumber(right, "/");
          if (divisor === 0) {
            throw new RuntimeError("AX2004", "Division by zero");
          }
          const result = expectNumber(left, "/") / divisor;
          if (!Number.isSafeInteger(result)) {
            throw new RuntimeError("AX2005", "Axiom integer division must produce a safe integer");
          }
          return result;
        }
        case "%": {
          const divisor = expectNumber(right, "%");
          if (divisor === 0) {
            throw new RuntimeError("AX2021", "Remainder by zero");
          }
          return expectNumber(left, "%") % divisor;
        }
        case "in":
          if (!Array.isArray(right)) {
            throw new RuntimeError("AX2006", "The right operand of `in` must be an array");
          }
          return right.some((value) => equal(left, value));
        default:
          throw new RuntimeError("AX2007", `Unknown binary operator \`${expression.operator}\``);
      }
    }
  }
}
