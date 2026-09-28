import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkWfPullRequest } from "./wf-pr-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TRUSTED_VALIDATOR_REF = "030dffcda7b44e11e026d22766c9afe5a08ea562";

function runValidator(path, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function event({ branch = "wf/1033-local-plans", body = "Closes #1033" } = {}) {
  return {
    repository: { full_name: "nuri-com/nuri-expo" },
    pull_request: { head: { ref: branch }, body },
  };
}

function issueResponse({ status = 200, payload = { number: 1033 } } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  });
}

describe("wf pull request issue linkage", () => {
  it("wires the bounded check only for wf pull-request branches", () => {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "wf-issue-link.yml"), "utf-8");

    assert.match(workflow, /pull_request:/);
    assert.match(workflow, /types: \[opened, synchronize, reopened, edited\]/);
    assert.match(workflow, /startsWith\(github\.head_ref, 'wf\/'\)/);
    assert.match(workflow, /timeout-minutes: 2/);
    assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    assert.match(workflow, new RegExp(`ref: ${TRUSTED_VALIDATOR_REF}`));
    assert.match(workflow, /sparse-checkout: tools\/wf-pr-check\.mjs/);
    assert.match(workflow, /sparse-checkout-cone-mode: false/);
    assert.match(workflow, /path: \.trusted-wf/);
    assert.match(workflow, /node \.trusted-wf\/tools\/wf-pr-check\.mjs/);
    assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.sha/);
  });

  it("runs the pinned validator after a production-shaped trusted-base checkout", async () => {
    const runner = mkdtempSync(join(tmpdir(), "wf-pr-check-runner-"));
    const trustedCheckout = join(runner, ".trusted-wf", "tools");
    const eventPath = join(runner, "event.json");
    mkdirSync(trustedCheckout, { recursive: true });
    writeFileSync(join(runner, "base-only.txt"), "trusted base without validator\n");
    copyFileSync(join(ROOT, "tools", "wf-pr-check.mjs"), join(trustedCheckout, "wf-pr-check.mjs"));
    writeFileSync(eventPath, JSON.stringify(event()));

    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ number: 1033 }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      assert(address && typeof address !== "string");
      const result = await runValidator(join(trustedCheckout, "wf-pr-check.mjs"), {
        GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_TOKEN: "test-token",
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Verified wf\/1033-local-plans/);
      assert.equal(
        readFileSync(join(runner, "base-only.txt"), "utf-8"),
        "trusted base without validator\n",
      );
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(runner, { recursive: true, force: true });
    }
  });

  it("accepts an existing canonical issue linked by closing evidence", async () => {
    const result = await checkWfPullRequest({
      event: event(),
      fetchImpl: issueResponse(),
      apiUrl: "https://api.github.test",
      token: "test-token",
    });

    assert.deepEqual(result, { branch: "wf/1033-local-plans", issueNumber: "1033" });
  });

  it("accepts canonical owner/repository issue closing evidence", async () => {
    const result = await checkWfPullRequest({
      event: event({ body: "Fixes nuri-com/nuri-expo#1033" }),
      fetchImpl: issueResponse(),
      apiUrl: "https://api.github.test",
      token: "test-token",
    });

    assert.deepEqual(result, { branch: "wf/1033-local-plans", issueNumber: "1033" });
  });

  it("rejects owner/repository closing evidence for another repository", async () => {
    await assert.rejects(
      checkWfPullRequest({
        event: event({ body: "Fixes another-org/another-repo#1033" }),
        fetchImpl: issueResponse(),
        apiUrl: "https://api.github.test",
        token: "test-token",
      }),
      /must contain canonical closing evidence for issue #1033/,
    );
  });

  for (const branch of ["wf/no-issue", "wf/1033", "feature/1033-local-plans"]) {
    it(`rejects malformed branch ${branch}`, async () => {
      await assert.rejects(
        checkWfPullRequest({
          event: event({ branch }),
          fetchImpl: issueResponse(),
          apiUrl: "https://api.github.test",
          token: "test-token",
        }),
        /must match wf\/<issue-number>-<slug>/,
      );
    });
  }

  it("rejects a nonexistent issue", async () => {
    await assert.rejects(
      checkWfPullRequest({
        event: event(),
        fetchImpl: issueResponse({ status: 404 }),
        apiUrl: "https://api.github.test",
        token: "test-token",
      }),
      /Issue #1033 does not exist or is not accessible \(404\)/,
    );
  });

  it("rejects an issue number that resolves to a pull request", async () => {
    await assert.rejects(
      checkWfPullRequest({
        event: event(),
        fetchImpl: issueResponse({ payload: { number: 1033, pull_request: {} } }),
        apiUrl: "https://api.github.test",
        token: "test-token",
      }),
      /not the canonical issue/,
    );
  });

  it("rejects missing canonical PR linkage evidence", async () => {
    await assert.rejects(
      checkWfPullRequest({
        event: event({ body: "Related to #1033\n\nCloses #999" }),
        fetchImpl: issueResponse(),
        apiUrl: "https://api.github.test",
        token: "test-token",
      }),
      /must contain canonical closing evidence for issue #1033/,
    );
  });
});
