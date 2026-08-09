/** Source and AIR identifiers are ASCII and therefore code-unit/scalar equal. */
export const MAX_IDENTIFIER_LENGTH = 256;

/** AXIP identity and operation fields are bounded in Unicode scalar values. */
export const MAX_AXIP_TEXT_SCALARS = 1_024;

/** A repeat bound is deliberately small enough for portable admission checks. */
export const MAX_REPEAT_ITERATIONS = 1_024;

/** Bounds recursive verification and compact dynamic execution addresses. */
export const MAX_CONTROL_DEPTH = 16;

/** Per-node retry cap for Core 0.2 model inference. */
export const MAX_INFER_ATTEMPTS = 16;

/** Portable admission caps for one worst-case Core 0.2 task execution. */
export const MAX_TASK_OPERATION_BOUND = 1_000_000;
export const MAX_TASK_EFFECT_BOUND = 1_000_000;
