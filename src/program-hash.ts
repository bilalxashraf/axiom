import {
  canonicalHash,
  type JsonObject,
  type Sha256,
} from "./canonical.ts";
import type { AirProgram } from "./ir.ts";

export const SEMANTIC_HASH_DOMAIN = "AXIOM-PROGRAM/0.1";

/**
 * Hash only executable semantics. `sourceHash` remains in AIR as provenance,
 * but comments and formatting must not change effect identities or make an
 * otherwise compatible replay diverge.
 */
export function semanticProgramHash(program: AirProgram): Sha256 {
  const semanticProgram: JsonObject = {
    format: program.format,
    language: program.language,
    records: program.records,
    propositions: program.propositions,
    ports: program.ports,
    tasks: program.tasks,
  };
  return canonicalHash({
    domain: SEMANTIC_HASH_DOMAIN,
    program: semanticProgram,
  });
}

/** Hash the exact canonical AIR artifact, including source provenance. */
export function artifactProgramHash(program: AirProgram): Sha256 {
  return canonicalHash(program);
}
