import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = process.cwd();

function fail(message) {
  throw new Error(message);
}

function filesUnder(path, predicate) {
  const result = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      result.push(...filesUnder(child, predicate));
    } else if (predicate(child)) {
      result.push(child);
    }
  }
  return result;
}

const markdown = [
  ...readdirSync(root)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(root, name)),
  ...filesUnder(join(root, "docs"), (path) => path.endsWith(".md")),
  ...filesUnder(join(root, "spec"), (path) => path.endsWith(".md")),
];
const markdownLink = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
for (const path of markdown) {
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(markdownLink)) {
    const rawTarget = match[1];
    if (
      rawTarget === undefined ||
      rawTarget.startsWith("#") ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(rawTarget)
    ) {
      continue;
    }
    const targetWithoutAnchor = rawTarget.split("#", 1)[0];
    if (targetWithoutAnchor === undefined || targetWithoutAnchor.length === 0) {
      continue;
    }
    const target = resolve(
      dirname(path),
      decodeURIComponent(targetWithoutAnchor.replace(/^<|>$/gu, "")),
    );
    const fromRoot = relative(root, target);
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      resolve(root, fromRoot) !== target
    ) {
      fail(`${relative(root, path)} links outside the repository: ${rawTarget}`);
    }
    if (!existsSync(target)) {
      fail(`${relative(root, path)} has a broken local link: ${rawTarget}`);
    }
  }
}

const workflowDirectory = join(root, ".github", "workflows");
const workflows = filesUnder(
  workflowDirectory,
  (path) => path.endsWith(".yml") || path.endsWith(".yaml"),
);
for (const path of workflows) {
  const source = readFileSync(path, "utf8");
  if (!/^permissions:/mu.test(source)) {
    fail(`${relative(root, path)} must declare top-level permissions`);
  }
  const actionReference = /^\s*uses:\s+[^@\s]+@([^\s#]+)/gmu;
  for (const match of source.matchAll(actionReference)) {
    const revision = match[1];
    if (revision === undefined || !/^[0-9a-f]{40}$/u.test(revision)) {
      fail(
        `${relative(root, path)} has a GitHub Action not pinned to a full commit SHA`,
      );
    }
  }
}

const packageJson = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const packageLock = JSON.parse(
  readFileSync(join(root, "package-lock.json"), "utf8"),
);
const vectors = JSON.parse(
  readFileSync(join(root, "spec", "conformance-vectors.json"), "utf8"),
);
if (
  packageJson.version !== packageLock.version ||
  packageJson.version !== packageLock.packages?.[""]?.version
) {
  fail("package.json and package-lock.json versions differ");
}
if (
  packageJson.repository?.type !== "git" ||
  !/^git\+https:\/\/github\.com\/[^/]+\/[^/]+\.git$/u.test(
    packageJson.repository?.url ?? "",
  )
) {
  fail("package.json must declare an HTTPS GitHub repository");
}
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+#readme$/u.test(packageJson.homepage)) {
  fail("package.json must declare a GitHub README homepage");
}
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues$/u.test(packageJson.bugs?.url)) {
  fail("package.json must declare a GitHub issues URL");
}

const npmVersion = packageJson.packageManager?.match(/^npm@(.+)$/u)?.[1];
if (npmVersion === undefined) {
  fail("package.json must pin npm through packageManager");
}
for (const path of workflows) {
  const source = readFileSync(path, "utf8");
  if (
    source.includes("npm ci") &&
    !source.includes(`npm install --global npm@${npmVersion}`)
  ) {
    fail(
      `${relative(root, path)} installs dependencies without pinning npm ${npmVersion}`,
    );
  }
}

const lockSource = readFileSync(join(root, "src", "lock.ts"), "utf8");
const versionMatch = lockSource.match(
  /AXIOM_TOOLCHAIN_VERSION\s*=\s*"([^"]+)"/u,
);
if (versionMatch?.[1] !== packageJson.version) {
  fail("AXIOM_TOOLCHAIN_VERSION differs from package.json");
}
const legacyVersionMatch = lockSource.match(
  /AXIOM_TOOLCHAIN_VERSION_0_1\s*=\s*"([^"]+)"/u,
);
if (
  legacyVersionMatch === null ||
  vectors.versions?.toolchain !==
    `${packageJson.name}@${legacyVersionMatch[1]}`
) {
  fail("The frozen Core 0.1 conformance vector names a different legacy toolchain version");
}

for (const required of [
  ".github/CODEOWNERS",
  ".github/workflows/ci.yml",
  ".github/workflows/determinism.yml",
  ".github/workflows/release.yml",
  ".github/workflows/security.yml",
  "LICENSE",
  "SECURITY.md",
  "spec/conformance-vectors.json",
  "spec/control-flow-vectors.json",
]) {
  const path = join(root, required);
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`Required repository artifact is missing: ${required}`);
  }
}

process.stdout.write(
  `repository checks passed (${markdown.length} Markdown files, ` +
    `${workflows.length} workflows)\n`,
);
