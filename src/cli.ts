#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  access,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";

import type { AgentModelAdapter } from "./adapters.ts";
import { HttpTextAdapter } from "./adapters.ts";
import { verifyAirProgram } from "./air-validator.ts";
import type { Program, SourceDecl } from "./ast.ts";
import {
  FixtureBindings,
  type FixtureConfig,
  type RuntimeBindings,
} from "./bindings.ts";
import {
  canonicalHash,
  canonicalJson,
  canonicalJsonBytes,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "./canonical.ts";
import { compileAst } from "./compiler.ts";
import { checkAdapterConformance } from "./conformance.ts";
import { AxiomError } from "./errors.ts";
import type { AirProgram, CompiledProgram } from "./ir.ts";
import { Ledger } from "./ledger.ts";
import {
  createProgramLock,
  verifyProgramLock,
  type BindingLock,
} from "./lock.ts";
import {
  assertMarkdownMapMatchesSource,
  importMarkdown,
  validateMarkdownCoverageMap,
  type MarkdownCoverageMap,
} from "./markdown.ts";
import { parse } from "./parser.ts";
import {
  artifactProgramHash,
  semanticProgramHash,
} from "./program-hash.ts";
import { AXIP_PROLOGUE_HASH } from "./protocol.ts";
import { runTask } from "./vm.ts";

type ParsedArguments = {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string | true>;
};

const MAX_CLI_INPUT_BYTES = 64 * 1024 * 1024;

const BOOLEAN_OPTIONS = new Set(["cached-prologue"]);
const COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  help: [],
  "--help": [],
  "-h": [],
  "import-md": ["output", "map", "source-id"],
  check: ["map"],
  compile: ["output", "map"],
  lock: [
    "output",
    "fixtures",
    "adapter-url",
    "cached-prologue",
    "binding-id",
    "binding-fingerprint",
    "map",
  ],
  "verify-lock": [
    "lock",
    "fixtures",
    "adapter-url",
    "cached-prologue",
    "binding-id",
    "binding-fingerprint",
    "map",
  ],
  run: [
    "task",
    "input",
    "fixtures",
    "adapter-url",
    "lock",
    "ledger",
    "run-id",
    "inference-timeout-ms",
    "effect-timeout-ms",
    "cached-prologue",
    "map",
  ],
  replay: ["task", "input", "ledger", "output-ledger", "map"],
  frame: [
    "task",
    "input",
    "fixtures",
    "adapter-url",
    "lock",
    "run-id",
    "inference-timeout-ms",
    "effect-timeout-ms",
    "cached-prologue",
    "map",
  ],
  conform: ["adapter-url", "timeout-ms", "cached-prologue"],
};

const HELP = `Axiom Core 0.1 + 0.2

Usage:
  axiom import-md <instructions.md> -o <instructions.ax>
                  [--map <instructions.axmap.json>] [--source-id <identifier>]
  axiom check <program.ax> [--map <required.axmap.json>]
  axiom compile <program.ax> -o <program.air>
                [--map <required.axmap.json>]
  axiom lock <program.ax|program.air> -o <axiom.lock>
             [--fixtures <fixtures.json>] [--adapter-url <url>]
             [--cached-prologue]
             [--binding-id <id> --binding-fingerprint <sha256:...>]
             [--map <required.axmap.json>]
  axiom verify-lock <program.ax|program.air> --lock <axiom.lock>
                    [--fixtures <fixtures.json>] [--adapter-url <url>]
                    [--cached-prologue]
                    [--binding-id <id> --binding-fingerprint <sha256:...>]
                    [--map <required.axmap.json>]
  axiom run <program.ax|program.air> --task <name> --input <input.json>
            --fixtures <fixtures.json> [--adapter-url <url>]
            [--lock <approved.lock>]
            [--ledger <run.axlog>] [--run-id <id>]
            [--inference-timeout-ms <positive-integer>]
            [--effect-timeout-ms <positive-integer>]
            [--cached-prologue] [--map <required.axmap.json>]
  axiom replay <program.ax|program.air> --task <name> --input <input.json>
               --ledger <run.axlog> [--output-ledger <replay.axlog>]
               [--map <required.axmap.json>]
  axiom frame <program.ax|program.air> --task <name> --input <input.json>
              --fixtures <fixtures.json> [--map <required.axmap.json>]
              [--adapter-url <url>] [--lock <approved.lock>]
              [--inference-timeout-ms <positive-integer>]
              [--effect-timeout-ms <positive-integer>]
              [--cached-prologue]
  axiom conform --adapter-url <url> [--timeout-ms <positive-integer>]
                [--cached-prologue]

Commands:
  import-md  Create a lossless Axiom migration draft and coverage sidecar.
  check      Parse, type-check, and prove obligation-flow safety.
  compile    Emit canonical AIR/0.1 or AIR/0.2 JSON.
  lock       Freeze toolchain, AIR, capabilities, bounds, and host bindings.
  verify-lock  Fail unless a program and binding set exactly match its AXLOCK.
  run        Execute with fixture tool bindings and a fixture or HTTP model.
  replay     Re-execute from a ledger without calling models or tools.
  frame      Execute offline and print each compact AXIP model frame.
  conform    Probe an HTTP model adapter for baseline AXIP/1 compatibility.
`;

function parseArguments(argv: readonly string[]): ParsedArguments {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index] as string;
    if (!item.startsWith("-")) {
      positionals.push(item);
      continue;
    }
    const normalized = item === "-o" ? "output" : item.replace(/^--?/u, "");
    if (options.has(normalized)) {
      throw new Error(`Duplicate option --${normalized}`);
    }
    if (BOOLEAN_OPTIONS.has(normalized)) {
      options.set(normalized, true);
      continue;
    }
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      options.set(normalized, next);
      index += 1;
    } else {
      options.set(normalized, true);
    }
  }
  return { command, positionals, options };
}

function validateArguments(args: ParsedArguments): void {
  const allowed = COMMAND_OPTIONS[args.command];
  if (allowed === undefined) {
    return;
  }
  const allowedSet = new Set(allowed);
  for (const name of args.options.keys()) {
    if (!allowedSet.has(name)) {
      throw new Error(
        `Option --${name} is not valid for command ${args.command}`,
      );
    }
  }
  const expectedPositionals =
    args.command === "conform" ||
    args.command === "help" ||
    args.command === "--help" ||
    args.command === "-h"
      ? 0
      : 1;
  if (args.positionals.length > expectedPositionals) {
    throw new Error(
      `Command ${args.command} accepts ${expectedPositionals} positional argument(s), got ${args.positionals.length}`,
    );
  }
}

function option(
  args: ParsedArguments,
  name: string,
  required = false,
): string | undefined {
  const value = args.options.get(name);
  if (value === true) {
    throw new Error(`Missing required value after --${name}`);
  }
  if (value === undefined) {
    if (required) {
      throw new Error(`Missing required option --${name}`);
    }
    return undefined;
  }
  return value;
}

function defaultMapPath(outputPath: string): string {
  return outputPath.endsWith(".ax")
    ? `${outputPath.slice(0, -3)}.axmap.json`
    : `${outputPath}.axmap.json`;
}

function mapOption(args: ParsedArguments): string | undefined {
  const value = args.options.get("map");
  if (value === true) {
    throw new Error("Missing required path after --map");
  }
  return value;
}

function sourceIdOption(args: ParsedArguments): string | undefined {
  const value = args.options.get("source-id");
  if (value === true) {
    throw new Error("Missing required identifier after --source-id");
  }
  return value;
}

function positiveIntegerOption(
  args: ParsedArguments,
  name: string,
): number | undefined {
  if (args.options.get(name) === true) {
    throw new Error(`Missing required value after --${name}`);
  }
  const raw = option(args, name);
  if (raw === undefined) {
    return undefined;
  }
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new Error(`--${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`--${name} exceeds the safe integer range`);
  }
  return value;
}

async function readJson(path: string): Promise<JsonValue> {
  return parseJson(await readUtf8File(path));
}

async function readUtf8File(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_CLI_INPUT_BYTES) {
    throw new Error(
      `${JSON.stringify(path)} is ${bytes.byteLength} bytes; the CLI limit is ${MAX_CLI_INPUT_BYTES}`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${JSON.stringify(path)} is not valid UTF-8`);
  }
}

async function writeUtf8Atomic(path: string, contents: string): Promise<void> {
  const destination = resolve(path);
  const temporary = resolve(
    dirname(destination),
    `.${basename(destination)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function asObject(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value as JsonObject;
}

function sourceDeclarations(ast: Program): readonly SourceDecl[] {
  return ast.declarations.filter(
    (declaration): declaration is SourceDecl =>
      declaration.kind === "SourceDecl",
  );
}

function declaredMapPath(programPath: string, mapPath: string): string {
  if (mapPath.length === 0) {
    throw new Error("A source declaration cannot use an empty AXMAP sidecar path");
  }
  return isAbsolute(mapPath)
    ? resolve(mapPath)
    : resolve(dirname(resolve(programPath)), mapPath);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function readRequiredMarkdownMap(
  path: string,
  reason: string,
): Promise<MarkdownCoverageMap> {
  try {
    return validateMarkdownCoverageMap(await readJson(path));
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      throw new Error(
        `Required AXMAP/0.1 sidecar ${JSON.stringify(path)} is missing (${reason})`,
      );
    }
    throw error;
  }
}

async function verifyMarkdownAnchors(
  programPath: string,
  ast: Program,
  explicitMapPath: string | undefined,
): Promise<void> {
  const sources = sourceDeclarations(ast);
  const candidates = new Map<
    string,
    { readonly path: string; readonly reasons: Set<string> }
  >();
  const addCandidate = (path: string, reason: string): void => {
    const resolved = resolve(path);
    const existing = candidates.get(resolved);
    if (existing === undefined) {
      candidates.set(resolved, { path: resolved, reasons: new Set([reason]) });
    } else {
      existing.reasons.add(reason);
    }
  };

  const adjacent = resolve(defaultMapPath(resolve(programPath)));
  if (await exists(adjacent)) {
    addCandidate(adjacent, "adjacent sidecar");
  }
  if (explicitMapPath !== undefined) {
    addCandidate(resolve(explicitMapPath), "explicit --map anchor");
  }
  for (const source of sources) {
    addCandidate(
      declaredMapPath(programPath, source.mapPath),
      `source declaration ${JSON.stringify(source.name)}`,
    );
  }

  const loaded = new Map<string, MarkdownCoverageMap>();
  for (const candidate of candidates.values()) {
    const map = await readRequiredMarkdownMap(
      candidate.path,
      [...candidate.reasons].join(", "),
    );
    loaded.set(candidate.path, map);
    const source = sources.find(
      (declaration) => declaration.name === map.generated.source_id,
    );
    if (source === undefined) {
      throw new Error(
        `AXMAP/0.1 sidecar ${JSON.stringify(candidate.path)} expects source ` +
          `declaration ${JSON.stringify(map.generated.source_id)}, but that declaration is missing`,
      );
    }
    assertMarkdownMapMatchesSource(map, source);
  }

  for (const source of sources) {
    const path = declaredMapPath(programPath, source.mapPath);
    const map = loaded.get(path);
    if (map === undefined) {
      throw new Error(
        `Required AXMAP/0.1 sidecar ${JSON.stringify(path)} was not loaded for ` +
          `source declaration ${JSON.stringify(source.name)}`,
      );
    }
    assertMarkdownMapMatchesSource(map, source);
  }
}

async function loadCompiled(
  path: string,
  explicitMapPath?: string,
): Promise<CompiledProgram> {
  if (extname(path) !== ".air") {
    const source = await readUtf8File(path);
    const ast = parse(source, path);
    await verifyMarkdownAnchors(path, ast, explicitMapPath);
    return compileAst(ast, source);
  }
  if (explicitMapPath !== undefined) {
    throw new Error("--map provenance anchors require an Axiom .ax source file");
  }
  const value = await readJson(path);
  const program = asObject(value, "AIR file") as unknown as AirProgram;
  if (program.format !== "AIR/0.1" && program.format !== "AIR/0.2") {
    throw new Error(`Unsupported AIR format ${String(program.format)}`);
  }
  verifyAirProgram(program);
  return {
    hash: semanticProgramHash(program),
    artifactHash: artifactProgramHash(program),
    bytes: canonicalJsonBytes(program),
    program,
  };
}

async function loadBindings(
  fixturesPath: string,
  adapterUrl: string | undefined,
  cachedPrologue: boolean,
): Promise<RuntimeBindings> {
  const config = asObject(
    await readJson(fixturesPath),
    "Fixture file",
  ) as unknown as FixtureConfig;
  const fixtures = new FixtureBindings(config);
  if (adapterUrl === undefined) {
    return fixtures;
  }
  const model = new HttpTextAdapter({
    endpoint: adapterUrl,
    ...(cachedPrologue
      ? { cachedPrologueRefs: [AXIP_PROLOGUE_HASH] }
      : {}),
  });
  return {
    id: `${fixtures.id}+${model.id}`,
    fingerprint: canonicalHash({
      fixtures: fixtures.fingerprint,
      model_adapter: model.id,
      endpoint: adapterUrl,
      cached_prologue: cachedPrologue,
    }),
    model,
    callTool: fixtures.callTool.bind(fixtures),
    callValidator: fixtures.callValidator.bind(fixtures),
    callVerifier: fixtures.callVerifier.bind(fixtures),
  };
}

async function lockBinding(
  args: ParsedArguments,
): Promise<BindingLock | null> {
  const fixturesPath = option(args, "fixtures");
  const adapterUrl = option(args, "adapter-url");
  const cachedPrologue = args.options.get("cached-prologue") === true;
  const bindingId = option(args, "binding-id");
  const bindingFingerprint = option(args, "binding-fingerprint");
  if (
    fixturesPath !== undefined &&
    (bindingId !== undefined || bindingFingerprint !== undefined)
  ) {
    throw new Error(
      "--fixtures cannot be combined with --binding-id or --binding-fingerprint",
    );
  }
  if (fixturesPath !== undefined) {
    return runtimeBindingLock(
      await loadBindings(
        fixturesPath,
        adapterUrl,
        cachedPrologue,
      ),
    );
  }
  if (adapterUrl !== undefined || cachedPrologue) {
    throw new Error(
      "--adapter-url and --cached-prologue require --fixtures when creating or verifying a lock",
    );
  }
  if (
    (bindingId === undefined) !==
    (bindingFingerprint === undefined)
  ) {
    throw new Error(
      "--binding-id and --binding-fingerprint must be supplied together",
    );
  }
  if (bindingId === undefined || bindingFingerprint === undefined) {
    return null;
  }
  return {
    id: bindingId,
    fingerprint: bindingFingerprint as `sha256:${string}`,
  };
}

function runtimeBindingLock(bindings: RuntimeBindings): BindingLock {
  if (
    bindings.fingerprint === undefined ||
    !/^sha256:[0-9a-f]{64}$/u.test(bindings.fingerprint)
  ) {
    throw new Error(
      `Runtime binding ${JSON.stringify(bindings.id)} lacks a canonical SHA-256 fingerprint required by AXLOCK`,
    );
  }
  return {
    id: bindings.id,
    fingerprint: bindings.fingerprint as `sha256:${string}`,
  };
}

function captureFrames(
  bindings: RuntimeBindings,
  frames: string[],
): RuntimeBindings {
  const delegate = bindings.model;
  const model: AgentModelAdapter = {
    id: delegate.id,
    ...(delegate.cachedPrologueRefs === undefined
      ? {}
      : { cachedPrologueRefs: delegate.cachedPrologueRefs }),
    async complete(invocation, options) {
      frames.push(invocation.frame);
      return delegate.complete(invocation, options);
    },
  };
  return {
    id: bindings.id,
    ...(bindings.fingerprint === undefined
      ? {}
      : { fingerprint: bindings.fingerprint }),
    model,
    callTool: bindings.callTool.bind(bindings),
    callValidator: bindings.callValidator.bind(bindings),
    callVerifier: bindings.callVerifier.bind(bindings),
  };
}

async function execute(args: ParsedArguments, printFrames: boolean): Promise<number> {
  const programPath = args.positionals[0];
  if (programPath === undefined) {
    throw new Error(`${args.command} requires a program path`);
  }
  const task = option(args, "task", true) as string;
  const inputPath = option(args, "input", true) as string;
  const fixturesPath = option(args, "fixtures", true) as string;
  const compiled = await loadCompiled(programPath, mapOption(args));
  const input = asObject(await readJson(inputPath), "Input file");
  let bindings = await loadBindings(
    fixturesPath,
    option(args, "adapter-url"),
    args.options.get("cached-prologue") === true,
  );
  const lockPath = option(args, "lock");
  if (lockPath !== undefined) {
    verifyProgramLock(
      await readJson(lockPath),
      compiled,
      runtimeBindingLock(bindings),
    );
  }
  const frames: string[] = [];
  if (printFrames) {
    bindings = captureFrames(bindings, frames);
  }
  const inferenceTimeoutMs = positiveIntegerOption(
    args,
    "inference-timeout-ms",
  );
  const effectTimeoutMs = positiveIntegerOption(
    args,
    "effect-timeout-ms",
  );
  const ledgerPath = option(args, "ledger");
  const ledger =
    ledgerPath === undefined ? undefined : Ledger.createDurable(ledgerPath);
  let result;
  try {
    result = await runTask(compiled, {
      task,
      input,
      bindings,
      ...(ledger === undefined ? {} : { ledger }),
      ...(option(args, "run-id") === undefined
        ? {}
        : { runId: option(args, "run-id") as string }),
      ...(inferenceTimeoutMs === undefined
        ? {}
        : { inferenceTimeoutMs }),
      ...(effectTimeoutMs === undefined
        ? {}
        : { effectTimeoutMs }),
    });
  } finally {
    ledger?.close();
  }
  if (printFrames) {
    process.stdout.write(`${frames.join("\n\n")}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify(
        result.status === "success"
          ? {
              status: result.status,
              run_id: result.runId,
              program_hash: result.programHash,
              value: result.value,
              ledger_root: result.ledger.root,
            }
          : {
              status: result.status,
              run_id: result.runId,
              program_hash: result.programHash,
              error: result.error,
              ledger_root: result.ledger.root,
            },
        null,
        2,
      )}\n`,
    );
  }
  return result.status === "success" ? 0 : 1;
}

async function replay(args: ParsedArguments): Promise<number> {
  const programPath = args.positionals[0];
  if (programPath === undefined) {
    throw new Error("replay requires a program path");
  }
  const compiled = await loadCompiled(programPath, mapOption(args));
  const input = asObject(
    await readJson(option(args, "input", true) as string),
    "Input file",
  );
  const sourceLedger = await Ledger.read(option(args, "ledger", true) as string);
  const header = sourceLedger.entries.find((entry) => entry.kind === "run")?.payload;
  const headerObject =
    header === undefined ? undefined : asObject(header as JsonValue, "Run ledger header");
  const runId =
    headerObject !== undefined && typeof headerObject.run_id === "string"
      ? headerObject.run_id
      : "replay";
  const outputLedger = option(args, "output-ledger");
  const replayLedger =
    outputLedger === undefined
      ? undefined
      : Ledger.createDurable(outputLedger);
  let result;
  try {
    result = await runTask(compiled, {
      task: option(args, "task", true) as string,
      input,
      runId,
      replay: sourceLedger,
      ...(replayLedger === undefined ? {} : { ledger: replayLedger }),
    });
  } finally {
    replayLedger?.close();
  }
  process.stdout.write(
    `${JSON.stringify(
      result.status === "success"
        ? {
            status: result.status,
            value: result.value,
            replayed_effects: result.replayedEffects,
          }
        : {
            status: result.status,
            error: result.error,
            replayed_effects: result.replayedEffects,
          },
      null,
      2,
    )}\n`,
  );
  return result.status === "success" ? 0 : 1;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  validateArguments(args);
  let exitCode = 0;
  switch (args.command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    case "import-md": {
      const path = args.positionals[0];
      if (path === undefined) {
        throw new Error("import-md requires a Markdown path");
      }
      const output = option(args, "output", true) as string;
      const mapPath = mapOption(args) ?? defaultMapPath(output);
      const outputDirectory = dirname(resolve(output));
      const declaredMapPath = relative(outputDirectory, resolve(mapPath));
      if (declaredMapPath.length === 0) {
        throw new Error("The AXMAP sidecar path cannot be the same as the .ax output path");
      }
      const sourceId = sourceIdOption(args);
      const markdownBytes = await readFile(path);
      if (markdownBytes.byteLength > MAX_CLI_INPUT_BYTES) {
        throw new Error(
          `${JSON.stringify(path)} is ${markdownBytes.byteLength} bytes; the CLI limit is ${MAX_CLI_INPUT_BYTES}`,
        );
      }
      const imported = importMarkdown(markdownBytes, {
        sourcePath: path,
        axPath: output,
        mapPath: declaredMapPath,
        ...(sourceId === undefined ? {} : { sourceId }),
      });
      await Promise.all([
        writeUtf8Atomic(output, imported.axSource),
        writeUtf8Atomic(mapPath, `${canonicalJson(imported.map)}\n`),
      ]);
      const unresolved = imported.map.coverage.spans.filter(
        (span) => span.disposition.status === "unresolved",
      ).length;
      process.stdout.write(
        `${output} + ${mapPath}: ${imported.map.source.byte_length} source bytes, ` +
          `${unresolved} unresolved span${unresolved === 1 ? "" : "s"}\n`,
      );
      return;
    }
    case "check": {
      const path = args.positionals[0];
      if (path === undefined) {
        throw new Error("check requires a program path");
      }
      const compiled = await loadCompiled(path, mapOption(args));
      process.stdout.write(
        `ok ${compiled.program.format} semantic=${compiled.hash} artifact=${compiled.artifactHash} ` +
          `(${compiled.bytes.byteLength} bytes)\n`,
      );
      return;
    }
    case "compile": {
      const path = args.positionals[0];
      if (path === undefined) {
        throw new Error("compile requires a program path");
      }
      const output = option(args, "output", true) as string;
      const compiled = await loadCompiled(path, mapOption(args));
      await writeUtf8Atomic(
        output,
        `${canonicalJson(compiled.program)}\n`,
      );
      process.stdout.write(
        `${output} semantic=${compiled.hash} artifact=${compiled.artifactHash} ` +
          `${compiled.bytes.byteLength} bytes\n`,
      );
      return;
    }
    case "lock": {
      const path = args.positionals[0];
      if (path === undefined) {
        throw new Error("lock requires a program path");
      }
      const output = option(args, "output", true) as string;
      const compiled = await loadCompiled(path, mapOption(args));
      const lock = createProgramLock(compiled, await lockBinding(args));
      await writeUtf8Atomic(output, `${canonicalJson(lock)}\n`);
      process.stdout.write(
        `${output} ${lock.format} ${lock.program.semantic_hash}\n`,
      );
      return;
    }
    case "verify-lock": {
      const path = args.positionals[0];
      if (path === undefined) {
        throw new Error("verify-lock requires a program path");
      }
      const lockPath = option(args, "lock", true) as string;
      const compiled = await loadCompiled(path, mapOption(args));
      const value = await readJson(lockPath);
      verifyProgramLock(value, compiled, await lockBinding(args));
      const lockFormat =
        compiled.program.format === "AIR/0.2" ? "AXLOCK/0.2" : "AXLOCK/0.1";
      process.stdout.write(
        `ok ${lockFormat} ${compiled.hash} (${lockPath})\n`,
      );
      return;
    }
    case "run":
      exitCode = await execute(args, false);
      break;
    case "frame":
      exitCode = await execute(args, true);
      break;
    case "replay":
      exitCode = await replay(args);
      break;
    case "conform": {
      const cachedPrologue =
        args.options.get("cached-prologue") === true;
      const timeoutMs = positiveIntegerOption(args, "timeout-ms");
      const adapter = new HttpTextAdapter({
        endpoint: option(args, "adapter-url", true) as string,
        ...(cachedPrologue
          ? { cachedPrologueRefs: [AXIP_PROLOGUE_HASH] }
          : {}),
      });
      const result = await checkAdapterConformance(adapter, {
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      process.stdout.write(
        `${JSON.stringify(
          {
            status: "conformant",
            adapter_id: result.adapterId,
            model: result.model,
            request_hash: result.requestHash,
            frame_bytes: result.frameBytes,
            response_bytes: result.responseBytes,
            prologue: result.prologue,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    default:
      throw new Error(`Unknown command \`${args.command}\`\n\n${HELP}`);
  }
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  if (error instanceof AxiomError) {
    process.stderr.write(`${error.format()}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 2;
});
