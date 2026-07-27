import {
  doesNotThrow,
  match,
  ok,
  throws,
} from "node:assert/strict";
import { test } from "node:test";

import { verifyAirProgram } from "../src/air-validator.ts";
import { compileSource } from "../src/compiler.ts";
import { CheckError } from "../src/errors.ts";

const SOURCE = `
axiom 0.1;

record Receipt { changed: Bool; }
proposition Seen event;
proposition Stable state;

extern tool read_value(value: Text) -> Text mode read;
extern tool write_value(value: Text) -> Receipt mode write;
extern verifier saw(value: Text) proves Seen;
extern verifier stable(value: Text) proves Stable;

task Main(value: Text) -> Receipt
must {
  seen: Seen;
  stable_state: Stable;
}
{
  observe observed = read_value(value);
  verify seen_evidence = saw(observed);
  satisfy seen with seen_evidence;
  act receipt = write_value(observed) key hash(observed);
  verify stable_evidence = stable(observed);
  satisfy stable_state with stable_evidence;
  complete receipt;
}
`;

type MutableProgram = {
  [key: string]: any;
};

function validProgram(): MutableProgram {
  return structuredClone(
    compileSource(SOURCE, "air-validator.ax").program,
  ) as MutableProgram;
}

function expectInvalid(
  mutate: (program: MutableProgram) => void,
  message: RegExp,
): void {
  const program = validProgram();
  mutate(program);
  throws(
    () => verifyAirProgram(program),
    (error: unknown) => {
      ok(error instanceof CheckError);
      match(error.message, message);
      return true;
    },
  );
}

test("accepts compiler-emitted AIR/0.1", () => {
  doesNotThrow(() => verifyAirProgram(validProgram()));
});

test("fails closed on malformed object shapes", () => {
  expectInvalid(
    (program) => {
      program.tasks[0].operations[0].surprise = true;
    },
    /unexpected property/u,
  );
  expectInvalid(
    (program) => {
      delete program.ports[0].parameters;
    },
    /missing required property/u,
  );
  expectInvalid(
    (program) => {
      program.sourceHash = "not-a-hash";
    },
    /lowercase SHA-256/u,
  );
});

test("rejects duplicate declarations, fields, parameters, and obligations", () => {
  expectInvalid(
    (program) => {
      program.records.push(structuredClone(program.records[0]));
    },
    /duplicate declaration "Receipt"/u,
  );
  expectInvalid(
    (program) => {
      program.propositions.push(structuredClone(program.propositions[0]));
    },
    /duplicate declaration "Seen"/u,
  );
  expectInvalid(
    (program) => {
      program.ports.push(structuredClone(program.ports[0]));
    },
    /duplicate declaration "read_value"/u,
  );
  expectInvalid(
    (program) => {
      program.tasks.push(structuredClone(program.tasks[0]));
    },
    /duplicate declaration "Main"/u,
  );
  expectInvalid(
    (program) => {
      program.records[0].fields.push(
        structuredClone(program.records[0].fields[0]),
      );
    },
    /duplicate field "changed"/u,
  );
  expectInvalid(
    (program) => {
      program.ports[0].parameters.push(
        structuredClone(program.ports[0].parameters[0]),
      );
    },
    /duplicate parameter "value"/u,
  );
  expectInvalid(
    (program) => {
      program.tasks[0].obligations.push(
        structuredClone(program.tasks[0].obligations[0]),
      );
    },
    /duplicate obligation "seen"/u,
  );
});

test("rejects unknown types, propositions, and ports", () => {
  expectInvalid(
    (program) => {
      program.records[0].fields[0].type.name = "Missing";
    },
    /unknown type "Missing"/u,
  );
  expectInvalid(
    (program) => {
      program.records.push({
        name: "Candidate",
        fields: [],
      });
      program.records[0].fields[0].type.name = "Candidate";
    },
    /"Candidate" is a type constructor/u,
  );
  expectInvalid(
    (program) => {
      program.tasks[0].obligations[0].proposition = "Missing";
    },
    /unknown proposition "Missing"/u,
  );
  expectInvalid(
    (program) => {
      program.tasks[0].operations[0].port = "missing_port";
    },
    /unknown port "missing_port"/u,
  );
});

test("Evidence cannot cross declared data, port, or task boundaries", () => {
  const evidence = {
    kind: "evidence",
    proposition: "Seen",
  };
  expectInvalid(
    (program) => {
      program.records[0].fields[0].type = evidence;
    },
    /Evidence values cannot be stored in records/u,
  );
  expectInvalid(
    (program) => {
      program.ports[0].parameters[0].type = evidence;
    },
    /Evidence values cannot cross port boundaries/u,
  );
  expectInvalid(
    (program) => {
      program.ports[0].returns = evidence;
    },
    /Evidence values cannot cross port boundaries/u,
  );
  expectInvalid(
    (program) => {
      program.tasks[0].parameters[0].type = evidence;
    },
    /Evidence values cannot cross task boundaries/u,
  );
  expectInvalid(
    (program) => {
      program.tasks[0].returns = evidence;
    },
    /Evidence values cannot cross task boundaries/u,
  );
});

test("Candidate is accepted only as a top-level validator parameter", () => {
  expectInvalid(
    (program) => {
      program.ports[0].parameters[0].type = {
        kind: "list",
        element: {
          kind: "candidate",
          value: { kind: "named", name: "Text" },
        },
      };
    },
    /only validator ports may accept Candidate/u,
  );

  expectInvalid(
    (program) => {
      program.ports.push({
        kind: "validator",
        name: "nested_candidate",
        parameters: [
          {
            name: "raw",
            type: {
              kind: "list",
              element: {
                kind: "candidate",
                value: { kind: "named", name: "Text" },
              },
            },
          },
        ],
        returns: { kind: "named", name: "Text" },
      });
    },
    /Candidate must be a top-level validator parameter/u,
  );
});

test("deterministic builtins and ordering use runtime-safe operand types", () => {
  expectInvalid(
    (program) => {
      program.tasks[0].operations[3].idempotencyKey = {
        kind: "call",
        callee: "len",
        arguments: [{ kind: "literal", value: 1 }],
      };
    },
    /len expects exactly one Text or List argument/u,
  );
  expectInvalid(
    (program) => {
      program.tasks[0].operations[3].idempotencyKey = {
        kind: "call",
        callee: "contains",
        arguments: [
          { kind: "literal", value: "abc" },
          { kind: "literal", value: 1 },
        ],
      };
    },
    /contains expects Text\/Text or List<T>\/T arguments/u,
  );
  expectInvalid(
    (program) => {
      program.tasks[0].operations[3].idempotencyKey = {
        kind: "call",
        callee: "sort",
        arguments: [
          {
            kind: "array",
            items: [{ kind: "literal", value: true }],
          },
        ],
      };
    },
    /sort expects exactly one List<Int> or List<Text> argument/u,
  );
  expectInvalid(
    (program) => {
      program.tasks[0].operations.splice(3, 0, {
        op: "assert",
        site: 3,
        condition: {
          kind: "binary",
          operator: "<",
          left: { kind: "literal", value: true },
          right: { kind: "literal", value: false },
        },
        message: "Axiom assertion failed",
      });
      program.tasks[0].operations.forEach(
        (operation: MutableProgram, index: number) => {
          operation.site = index;
        },
      );
    },
    /< requires Int or Text operands/u,
  );
});

test("rejects an empty model intent in externally supplied AIR", () => {
  expectInvalid(
    (program) => {
      program.ports.push({
        kind: "model",
        name: "empty_model",
        parameters: [],
        returns: { kind: "named", name: "Text" },
        intent: "",
      });
    },
    /model intent cannot be empty/u,
  );
});

test("rejects wrong operation port kinds and tool modes", () => {
  expectInvalid(
    (program) => {
      program.tasks[0].operations[0].port = "write_value";
    },
    /observe requires a read tool/u,
  );
  expectInvalid(
    (program) => {
      program.tasks[0].operations[3].port = "read_value";
    },
    /act requires a write tool/u,
  );
  expectInvalid(
    (program) => {
      program.tasks[0].operations[0].port = "saw";
    },
    /expected a tool port/u,
  );
});

test("rejects verifier proposition forgery", () => {
  expectInvalid(
    (program) => {
      program.tasks[0].operations[1].proposition = "Stable";
    },
    /proves "Seen", not "Stable"/u,
  );
});

test("rejects unsupported future operations in certified Core 0.1", () => {
  for (const op of ["let", "must", "if"]) {
    expectInvalid(
      (program) => {
        program.tasks[0].operations.splice(0, 0, {
          op,
          site: 0,
        });
        program.tasks[0].operations.forEach(
          (operation: MutableProgram, index: number) => {
            operation.site = index;
          },
        );
      },
      /not an operation in certified Core 0\.1/u,
    );
  }
});

test("requires unique contiguous sites and immutable bindings", () => {
  expectInvalid(
    (program) => {
      program.tasks[0].operations[1].site = 0;
    },
    /sites must be unique and contiguous/u,
  );
  expectInvalid(
    (program) => {
      program.tasks[0].operations[1].destination = "observed";
    },
    /duplicate immutable binding "observed"/u,
  );
});

test("requires exactly one final terminal operation", () => {
  expectInvalid(
    (program) => {
      program.tasks[0].operations.pop();
    },
    /must contain a terminal/u,
  );
  expectInvalid(
    (program) => {
      program.tasks[0].operations.push({
        op: "fail",
        site: 7,
        message: "second terminal",
      });
    },
    /exactly one terminal/u,
  );
  expectInvalid(
    (program) => {
      const terminal = program.tasks[0].operations.pop();
      program.tasks[0].operations.splice(2, 0, terminal);
      program.tasks[0].operations.forEach(
        (operation: MutableProgram, index: number) => {
          operation.site = index;
        },
      );
    },
    /terminal operation must be the final operation/u,
  );
});

test("blocks complete while obligations are pending", () => {
  expectInvalid(
    (program) => {
      program.tasks[0].operations.splice(5, 1);
      program.tasks[0].operations.forEach(
        (operation: MutableProgram, index: number) => {
          operation.site = index;
        },
      );
    },
    /stable_state \(pending\)/u,
  );
});

test("rejects wrong and reused evidence", () => {
  expectInvalid(
    (program) => {
      program.tasks[0].operations[2].evidence = "stable_evidence";
    },
    /unknown or non-verifier evidence "stable_evidence"/u,
  );

  expectInvalid(
    (program) => {
      program.tasks[0].operations[5].evidence = "seen_evidence";
    },
    /already been consumed/u,
  );

  expectInvalid(
    (program) => {
      program.tasks[0].operations[2].obligation = "stable_state";
    },
    /evidence proves "Seen", but obligation requires "Stable"/u,
  );
});

test("a write makes both state obligations and state evidence stale", () => {
  expectInvalid(
    (program) => {
      const operations = program.tasks[0].operations;
      const verify = operations.splice(4, 1)[0];
      operations.splice(3, 0, verify);
      operations.forEach(
        (operation: MutableProgram, index: number) => {
          operation.site = index;
        },
      );
    },
    /state evidence "stable_evidence" is stale after an act/u,
  );

  expectInvalid(
    (program) => {
      const operations = program.tasks[0].operations;
      const act = operations.splice(3, 1)[0];
      operations.splice(5, 0, act);
      operations.forEach(
        (operation: MutableProgram, index: number) => {
          operation.site = index;
        },
      );
    },
    /stable_state \(stale\)/u,
  );
});
