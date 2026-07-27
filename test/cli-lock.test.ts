import { equal, match } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const CLI = join(ROOT, "dist", "src", "cli.js");

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("run can require an exact program and runtime-binding AXLOCK", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axiom-cli-lock-"));
  const lockPath = join(directory, "axiom.lock");
  const tamperedPath = join(directory, "tampered.lock");
  const adapterLockPath = join(directory, "adapter.lock");
  const program = join(ROOT, "examples", "fix.ax");
  const fixtures = join(ROOT, "examples", "fixtures.json");
  const input = join(ROOT, "examples", "input.json");

  const locked = runCli([
    "lock",
    program,
    "--output",
    lockPath,
    "--fixtures",
    fixtures,
  ]);
  equal(locked.status, 0, locked.stderr);

  const admitted = runCli([
    "run",
    program,
    "--task",
    "Fix",
    "--input",
    input,
    "--fixtures",
    fixtures,
    "--lock",
    lockPath,
    "--run-id",
    "locked-run",
  ]);
  equal(admitted.status, 0, admitted.stderr);
  match(admitted.stdout, /"status": "success"/u);

  const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
    program: { artifact_hash: string };
  };
  lock.program.artifact_hash =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  await writeFile(tamperedPath, `${JSON.stringify(lock)}\n`, "utf8");

  const rejected = runCli([
    "run",
    program,
    "--task",
    "Fix",
    "--input",
    input,
    "--fixtures",
    fixtures,
    "--lock",
    tamperedPath,
    "--run-id",
    "rejected-run",
  ]);
  equal(rejected.status, 2);
  match(rejected.stderr, /AX1605/u);

  const adapterUrl = "http://127.0.0.1:65535/axiom";
  const adapterLocked = runCli([
    "lock",
    program,
    "--output",
    adapterLockPath,
    "--fixtures",
    fixtures,
    "--adapter-url",
    adapterUrl,
    "--cached-prologue",
  ]);
  equal(adapterLocked.status, 0, adapterLocked.stderr);

  const adapterVerified = runCli([
    "verify-lock",
    program,
    "--lock",
    adapterLockPath,
    "--fixtures",
    fixtures,
    "--adapter-url",
    adapterUrl,
    "--cached-prologue",
  ]);
  equal(adapterVerified.status, 0, adapterVerified.stderr);

  const adapterPolicyChanged = runCli([
    "verify-lock",
    program,
    "--lock",
    adapterLockPath,
    "--fixtures",
    fixtures,
    "--adapter-url",
    adapterUrl,
  ]);
  equal(adapterPolicyChanged.status, 2);
  match(adapterPolicyChanged.stderr, /AX1605/u);
});
