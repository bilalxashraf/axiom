import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const root = process.cwd();
const npmCache = mkdtempSync(join(tmpdir(), "axiom-npm-cache-"));
const arguments_ = process.argv.slice(2);
if (
  arguments_.length > 1 ||
  (arguments_.length === 1 && arguments_[0] !== "--keep")
) {
  throw new Error("Usage: node scripts/verify-package.mjs [--keep]");
}
const keepArchive = arguments_[0] === "--keep";

process.once("exit", () => {
  rmSync(npmCache, { recursive: true, force: true });
});

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: npmCache,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function packOnce() {
  const output = run(npm, ["pack", "--json", "--ignore-scripts"]);
  const result = JSON.parse(output);
  if (!Array.isArray(result) || result.length !== 1) {
    throw new Error("npm pack did not return exactly one package description");
  }
  const metadata = result[0];
  const filename = basename(metadata.filename);
  if (
    filename !== metadata.filename ||
    !/^[A-Za-z0-9._-]+\.tgz$/u.test(filename)
  ) {
    throw new Error(`npm pack returned unsafe filename ${JSON.stringify(filename)}`);
  }
  const archivePath = join(root, filename);
  const bytes = readFileSync(archivePath);
  unlinkSync(archivePath);
  return { bytes, metadata };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const first = packOnce();
const second = packOnce();
if (!first.bytes.equals(second.bytes)) {
  throw new Error(
    `Repeated package archives differ: ${sha256(first.bytes)} != ${sha256(second.bytes)}`,
  );
}

const allowedFiles = new Set([
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "ROADMAP.md",
  "SECURITY.md",
  "package.json",
]);
const allowedPrefixes = [
  "dist/src/",
  "docs/",
  "examples/",
  "spec/",
  "src/",
];
for (const file of first.metadata.files) {
  if (
    !allowedFiles.has(file.path) &&
    !allowedPrefixes.some((prefix) => file.path.startsWith(prefix))
  ) {
    throw new Error(`Unexpected file in package archive: ${file.path}`);
  }
}
for (const required of [
  "dist/src/cli.js",
  "dist/src/index.js",
  "dist/src/index.d.ts",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "spec/conformance-vectors.json",
]) {
  if (!first.metadata.files.some((file) => file.path === required)) {
    throw new Error(`Required package file is missing: ${required}`);
  }
}

const temporary = mkdtempSync(join(tmpdir(), "axiom-package-"));
try {
  const archive = join(temporary, first.metadata.filename);
  writeFileSync(archive, first.bytes);
  writeFileSync(
    join(temporary, "package.json"),
    '{"name":"axiom-package-smoke","private":true,"type":"module"}\n',
  );
  run(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      archive,
    ],
    temporary,
  );
  run(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'const api = await import("@axiom-lang/core");',
        'if (typeof api.compileSource !== "function") throw new Error("missing compileSource");',
        'const compiled = api.compileSource("axiom 0.1; task Main() -> Unit must {} { complete unit; }");',
        'if (!compiled.hash.startsWith("sha256:")) throw new Error("invalid semantic hash");',
      ].join(""),
    ],
    temporary,
  );
  const cli = join(
    temporary,
    "node_modules",
    "@axiom-lang",
    "core",
    "dist",
    "src",
    "cli.js",
  );
  const help = run(node, [cli, "help"], temporary);
  if (!help.includes("Axiom Core 0.1")) {
    throw new Error("Installed CLI smoke test returned unexpected help");
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

if (keepArchive) {
  writeFileSync(join(root, first.metadata.filename), first.bytes, {
    flag: "wx",
    mode: 0o644,
  });
}

process.stdout.write(
  `verified ${first.metadata.filename} sha256:${sha256(first.bytes)} ` +
    `${first.metadata.files.length} files` +
    `${keepArchive ? " (retained)" : ""}\n`,
);
