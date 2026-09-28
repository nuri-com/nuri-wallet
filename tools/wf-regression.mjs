import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_CLI = join(SOURCE_ROOT, "tools", "wf.mjs");

let root;
let cli;
let binDir;

function run(command, args = [], env = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

function runWf(...args) {
  return run(process.execPath, [cli, ...args], {
    WF_AGENT: "test-agent",
    PATH: `${binDir}:${process.env.PATH}`,
  });
}

function runWfResult(...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, WF_AGENT: "test-agent", PATH: `${binDir}:${process.env.PATH}` },
  });
}

function stubGh(script) {
  writeFileSync(join(binDir, "gh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

function writePlan(name = "42-local-plan.md") {
  const plansDir = join(root, ".wf", "plans");
  mkdirSync(plansDir, { recursive: true });
  const path = join(plansDir, name);
  writeFileSync(path, "# temporary local plan\n");
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-local-plans-"));
  mkdirSync(join(root, "tools"));
  binDir = join(root, "bin");
  mkdirSync(binDir);
  cli = join(root, "tools", "wf.mjs");
  copyFileSync(SOURCE_CLI, cli);

  run("git", ["init", "-b", "wf/42-test"]);
  run("git", ["config", "user.name", "Workflow Test"]);
  run("git", ["config", "user.email", "workflow-test@example.com"]);
  writeFileSync(join(root, "README.md"), "fixture\n");
  run("git", ["add", "README.md"]);
  run("git", ["commit", "-m", "fixture"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("wf local plan state", () => {
  it("shows temporary plans only under .wf/plans", () => {
    writePlan();

    const output = runWf("status");

    assert.match(output, /Local plans:/);
    assert.match(output, /\.wf\/plans\/42-local-plan\.md/);
    assert.doesNotMatch(output, /PLANS_ARCHIVE/);
  });

  it("archive removes a temporary local plan", () => {
    const plan = writePlan();

    const output = runWf("archive", "42");

    assert.match(output, /Removed local plan: \.wf\/plans\/42-local-plan\.md/);
    assert.throws(() => readFileSync(plan));
  });

  it("done releases owned locks and removes the plan after a verified PR handoff", () => {
    const plan = writePlan();
    const locksDir = join(root, ".wf", "locks");
    mkdirSync(locksDir, { recursive: true });
    const lock = join(locksDir, "owned.lock");
    writeFileSync(lock, JSON.stringify({ file: "owned.ts", agent: "test-agent" }));
    stubGh(
      'printf \'%s\\n\' \'{"url":"https://github.com/nuri-com/nuri-expo/pull/99","body":"Closes #42"}\'',
    );

    const output = runWf("done");

    assert.match(output, /Released: owned\.ts/);
    assert.match(
      output,
      /Verified PR handoff: https:\/\/github\.com\/nuri-com\/nuri-expo\/pull\/99/,
    );
    assert.match(output, /Removed local plan: \.wf\/plans\/42-local-plan\.md/);
    assert.throws(() => readFileSync(lock));
    assert.throws(() => readFileSync(plan));
  });

  it("done retains the plan but still releases locks when no PR exists", () => {
    const plan = writePlan();
    const locksDir = join(root, ".wf", "locks");
    mkdirSync(locksDir, { recursive: true });
    const lock = join(locksDir, "owned.lock");
    writeFileSync(lock, JSON.stringify({ file: "owned.ts", agent: "test-agent" }));
    stubGh("printf '%s\\n' 'no pull requests found' >&2\nexit 1");

    const result = runWfResult("done");

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Released: owned\.ts/);
    assert.match(result.stderr, /Cannot remove the local plan until branch .* has a verified PR/);
    assert.match(result.stderr, /Retained local plan: \.wf\/plans\/42-local-plan\.md/);
    assert.doesNotThrow(() => readFileSync(plan));
    assert.throws(() => readFileSync(lock));
  });

  it("done retains the plan when PR lookup returns invalid data", () => {
    const plan = writePlan();
    stubGh("printf '%s\\n' 'not-json'");

    const result = runWfResult("done");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /PR lookup failed: gh returned invalid PR data/);
    assert.match(result.stderr, /Retained local plan/);
    assert.doesNotThrow(() => readFileSync(plan));
  });

  it("done retains the plan when the PR lacks canonical issue linkage", () => {
    const plan = writePlan();
    stubGh(
      'printf \'%s\\n\' \'{"url":"https://github.com/nuri-com/nuri-expo/pull/99","body":"Related to #42"}\'',
    );

    const result = runWfResult("done");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /canonical closing evidence for issue #42/);
    assert.match(result.stderr, /Retained local plan/);
    assert.doesNotThrow(() => readFileSync(plan));
  });

  it("done retains the plan when closing evidence names another repository", () => {
    const plan = writePlan();
    stubGh(
      'printf \'%s\\n\' \'{"url":"https://github.com/nuri-com/nuri-expo/pull/99","body":"Closes another-org/another-repo#42"}\'',
    );

    const result = runWfResult("done");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /canonical closing evidence for issue #42/);
    assert.doesNotThrow(() => readFileSync(plan));
  });

  it("builds PR summary and test evidence from the issue, not a plan", () => {
    const source = readFileSync(SOURCE_CLI, "utf-8");

    assert.match(source, /issue view \$\{issueNum\} --json title,body/);
    assert.match(source, /extractSection\(issue\.body \|\| "", "Summary"\)/);
    assert.match(source, /extractSection\(issue\.body \|\| "", "Test notes"\)/);
    assert.doesNotMatch(source, /\[Plan file\]/);
    assert.doesNotMatch(source, /join\(ROOT, "PLANS"\)/);
    assert.doesNotMatch(source, /join\(ROOT, "PLANS_ARCHIVE"\)/);
  });
});
