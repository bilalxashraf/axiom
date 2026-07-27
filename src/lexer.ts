import { ParseError, type SourceLocation } from "./errors.ts";
import type { SourceSpan } from "./ast.ts";
import { assertUnicodeScalarString } from "./canonical.ts";
import { MAX_IDENTIFIER_LENGTH } from "./limits.ts";

export type TokenKind =
  | "identifier"
  | "number"
  | "string"
  | "punctuation"
  | "eof";

export type Token = {
  readonly kind: TokenKind;
  /** Decoded value for strings, source spelling for every other token. */
  readonly value: string;
  readonly raw: string;
  readonly span: SourceSpan;
};

const DOUBLE_PUNCTUATION = new Set([
  "->",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
]);

const SINGLE_PUNCTUATION = new Set(
  "{}()[]:;,?.<>+-*/%=!".split(""),
);
function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/u.test(character);
}

function isIdentifierContinue(character: string): boolean {
  return /[A-Za-z0-9_]/u.test(character);
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

export class Lexer {
  readonly source: string;
  readonly sourceName: string;

  private offset = 0;
  private line = 1;
  private column = 1;

  constructor(source: string, sourceName = "<source>") {
    this.source = source;
    this.sourceName = sourceName;
  }

  tokenize(): readonly Token[] {
    const tokens: Token[] = [];

    while (true) {
      this.skipTrivia();
      if (this.offset >= this.source.length) {
        const location = this.location();
        tokens.push({
          kind: "eof",
          value: "",
          raw: "",
          span: this.span(location, location),
        });
        return tokens;
      }

      const start = this.location();
      const character = this.peek();

      if (isIdentifierStart(character)) {
        tokens.push(this.identifier(start));
        continue;
      }
      if (isDigit(character)) {
        tokens.push(this.number(start));
        continue;
      }
      if (character === '"' || character === "'") {
        tokens.push(this.string(start, character));
        continue;
      }

      const double = `${character}${this.peek(1)}`;
      if (DOUBLE_PUNCTUATION.has(double)) {
        this.advance();
        this.advance();
        tokens.push(this.simpleToken("punctuation", double, start));
        continue;
      }
      if (SINGLE_PUNCTUATION.has(character)) {
        this.advance();
        tokens.push(this.simpleToken("punctuation", character, start));
        continue;
      }

      throw new ParseError(
        "A100",
        `Unexpected character ${JSON.stringify(character)}.`,
        start,
      );
    }
  }

  private identifier(start: SourceLocation): Token {
    this.advance();
    while (
      this.offset < this.source.length &&
      isIdentifierContinue(this.peek())
    ) {
      this.advance();
    }
    const raw = this.source.slice(start.offset, this.offset);
    if (raw.length > MAX_IDENTIFIER_LENGTH) {
      throw new ParseError(
        "A107",
        `Identifiers cannot exceed ${MAX_IDENTIFIER_LENGTH} ASCII characters.`,
        start,
      );
    }
    return this.simpleToken("identifier", raw, start, raw);
  }

  private number(start: SourceLocation): Token {
    while (isDigit(this.peek())) {
      this.advance();
    }

    if (this.peek() === "." && isDigit(this.peek(1))) {
      this.advance();
      while (isDigit(this.peek())) {
        this.advance();
      }
    }

    if (this.peek() === "e" || this.peek() === "E") {
      const exponentOffset = this.offset;
      this.advance();
      if (this.peek() === "+" || this.peek() === "-") {
        this.advance();
      }
      if (!isDigit(this.peek())) {
        throw new ParseError(
          "A101",
          "A numeric exponent must contain at least one digit.",
          this.locationAt(exponentOffset),
        );
      }
      while (isDigit(this.peek())) {
        this.advance();
      }
    }

    const raw = this.source.slice(start.offset, this.offset);
    return this.simpleToken("number", raw, start, raw);
  }

  private string(start: SourceLocation, quote: string): Token {
    this.advance();
    let value = "";

    while (this.offset < this.source.length) {
      const character = this.peek();
      if (character === quote) {
        this.advance();
        try {
          assertUnicodeScalarString(value);
        } catch {
          throw new ParseError(
            "A108",
            "String literals must contain only Unicode scalar values.",
            start,
          );
        }
        const raw = this.source.slice(start.offset, this.offset);
        return this.simpleToken("string", value, start, raw);
      }
      if (character === "\n" || character === "\r") {
        throw new ParseError(
          "A102",
          "String literals cannot contain an unescaped newline.",
          this.location(),
        );
      }
      if (character !== "\\") {
        value += this.advance();
        continue;
      }

      this.advance();
      if (this.offset >= this.source.length) {
        break;
      }
      const escaped = this.advance();
      switch (escaped) {
        case '"':
          value += '"';
          break;
        case "'":
          value += "'";
          break;
        case "\\":
          value += "\\";
          break;
        case "/":
          value += "/";
          break;
        case "b":
          value += "\b";
          break;
        case "f":
          value += "\f";
          break;
        case "n":
          value += "\n";
          break;
        case "r":
          value += "\r";
          break;
        case "t":
          value += "\t";
          break;
        case "u":
          value += this.unicodeEscape();
          break;
        default:
          throw new ParseError(
            "A103",
            `Unknown escape sequence \\${escaped}.`,
            this.locationAt(this.offset - 2),
          );
      }
    }

    throw new ParseError("A104", "Unterminated string literal.", start);
  }

  private unicodeEscape(): string {
    const start = this.location();
    const digits = this.source.slice(this.offset, this.offset + 4);
    if (!/^[0-9A-Fa-f]{4}$/u.test(digits)) {
      throw new ParseError(
        "A105",
        "Unicode escapes must contain exactly four hexadecimal digits.",
        start,
      );
    }
    for (let index = 0; index < 4; index += 1) {
      this.advance();
    }
    return String.fromCharCode(Number.parseInt(digits, 16));
  }

  private skipTrivia(): void {
    while (this.offset < this.source.length) {
      const character = this.peek();
      if (
        character === " " ||
        character === "\t" ||
        character === "\n" ||
        character === "\r" ||
        character === "\uFEFF"
      ) {
        this.advance();
        continue;
      }

      if (character === "/" && this.peek(1) === "/") {
        this.advance();
        this.advance();
        while (
          this.offset < this.source.length &&
          this.peek() !== "\n" &&
          this.peek() !== "\r"
        ) {
          this.advance();
        }
        continue;
      }

      if (character === "#") {
        while (
          this.offset < this.source.length &&
          this.peek() !== "\n" &&
          this.peek() !== "\r"
        ) {
          this.advance();
        }
        continue;
      }

      if (character === "/" && this.peek(1) === "*") {
        const commentStart = this.location();
        this.advance();
        this.advance();
        let closed = false;
        while (this.offset < this.source.length) {
          if (this.peek() === "*" && this.peek(1) === "/") {
            this.advance();
            this.advance();
            closed = true;
            break;
          }
          this.advance();
        }
        if (!closed) {
          throw new ParseError(
            "A106",
            "Unterminated block comment.",
            commentStart,
          );
        }
        continue;
      }

      return;
    }
  }

  private peek(distance = 0): string {
    return this.source[this.offset + distance] ?? "";
  }

  private advance(): string {
    const character = this.source[this.offset] ?? "";
    if (character === "") {
      return "";
    }

    this.offset += 1;
    if (character === "\r") {
      if (this.source[this.offset] === "\n") {
        this.offset += 1;
      }
      this.line += 1;
      this.column = 1;
    } else if (character === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return character;
  }

  private location(): SourceLocation {
    return {
      offset: this.offset,
      line: this.line,
      column: this.column,
    };
  }

  /**
   * Used only for diagnostics within a token. Lines cannot change in those
   * cases, so reconstructing from the current position is exact.
   */
  private locationAt(offset: number): SourceLocation {
    return {
      offset,
      line: this.line,
      column: Math.max(1, this.column - (this.offset - offset)),
    };
  }

  private span(start: SourceLocation, end: SourceLocation): SourceSpan {
    return {
      sourceName: this.sourceName,
      start,
      end,
    };
  }

  private simpleToken(
    kind: TokenKind,
    value: string,
    start: SourceLocation,
    raw = value,
  ): Token {
    return {
      kind,
      value,
      raw,
      span: this.span(start, this.location()),
    };
  }
}

export function tokenize(
  source: string,
  sourceName = "<source>",
): readonly Token[] {
  return new Lexer(source, sourceName).tokenize();
}
