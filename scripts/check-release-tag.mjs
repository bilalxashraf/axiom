import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const expected = `v${packageJson.version}`;
const actual = process.env.GITHUB_REF_NAME;
if (actual !== expected) {
  throw new Error(
    `Release tag ${JSON.stringify(actual)} does not match package version ${JSON.stringify(expected)}`,
  );
}
process.stdout.write(`release tag ${actual} matches package version\n`);
