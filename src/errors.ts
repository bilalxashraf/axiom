export type SourceLocation = {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
};

export class AxiomError extends Error {
  readonly code: string;
  readonly location: SourceLocation | undefined;

  constructor(code: string, message: string, location?: SourceLocation) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.location = location;
  }

  format(sourceName = "<source>"): string {
    if (this.location === undefined) {
      return `${this.code}: ${this.message}`;
    }
    return `${sourceName}:${this.location.line}:${this.location.column}: ${this.code}: ${this.message}`;
  }
}

export class ParseError extends AxiomError {}
export class CheckError extends AxiomError {}
export class RuntimeError extends AxiomError {}
export class ReplayError extends AxiomError {}
