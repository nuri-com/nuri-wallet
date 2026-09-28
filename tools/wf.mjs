#!/usr/bin/env node
// wf — Multi-agent workflow CLI for nuri-expo
// Usage: node tools/wf.mjs <command> [args...]

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

// ── Constants ────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, "..");
const LOCKS_DIR = join(ROOT, ".wf", "locks");
const PLANS_DIR = join(ROOT, ".wf", "plans");
const STALE_MS = 4 * 60 * 60 * 1000; // 4 hours
const SLUG_MAX = 40;
const PR_BASE_BRANCH = "dev";
const CLOSING_KEYWORD =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:(?<repository>[a-z0-9_.-]+\/[a-z0-9_.-]+))?#(?<issue>\d+)\b/gi;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getAgent() {
  return process.env.WF_AGENT || process.env.USER || "unknown";
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      ...opts,
    }).trim();
  } catch (e) {
    if (opts.allowFail) return "";
    const stderr = e.stderr?.toString().trim() || e.message;
    console.error(`Error running: ${cmd}\n${stderr}`);
    process.exit(1);
  }
}

function gh(args, opts = {}) {
  // Verify gh is available
  try {
    execSync("which gh", { stdio: "pipe" });
  } catch {
    console.error("Error: gh CLI not found. Install it: https://cli.github.com/");
    process.exit(1);
  }
  return run(`gh ${args}`, opts);
}

function currentBranchPr(branch) {
  const result = spawnSync("gh", ["pr", "view", branch, "--json", "url,body"], {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) return { error: result.error.message };
  if (result.status !== 0) {
    return { error: result.stderr.trim() || `gh exited with status ${result.status}` };
  }

  try {
    const pr = JSON.parse(result.stdout);
    return pr.url ? { url: pr.url, body: pr.body || "" } : {};
  } catch {
    return { error: "gh returned invalid PR data" };
  }
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, SLUG_MAX);
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function today() {
  return new Date().toISOString().split("T")[0];
}

function lockPath(file) {
  const key = file.replace(/[\\/]/g, "__");
  return join(LOCKS_DIR, `${key}.lock`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(lockFile) {
  try {
    return JSON.parse(readFileSync(lockFile, "utf-8"));
  } catch {
    return null;
  }
}

function isStale(lock) {
  if (!lock) return true;
  const age = Date.now() - lock.timestamp;
  if (age > STALE_MS) return true;
  if (lock.pid && !isProcessAlive(lock.pid)) return true;
  return false;
}

function currentBranch() {
  return run("git branch --show-current", { allowFail: true });
}

function issueNumberFromBranch(branch) {
  const m = branch?.match(/^wf\/(\d+)-/);
  return m ? m[1] : null;
}

function planFileForIssue(num) {
  // Find existing plan file matching the issue number
  ensureDir(PLANS_DIR);
  const files = readdirSync(PLANS_DIR);
  const match = files.find((f) => f.startsWith(`${num}-`) && f.endsWith(".md"));
  if (match) return join(PLANS_DIR, match);
  return null;
}

function extractSection(content, heading) {
  const re = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, "m");
  const m = content.match(re);
  if (!m) return "";
  return m[1].replace(/<!--.*?-->/gs, "").trim();
}

function isDirty() {
  const status = run("git status --porcelain", { allowFail: true });
  return status.length > 0;
}

// ── Commands ─────────────────────────────────────────────────────────────────

// ── issues ───────────────────────────────────────────────────────────────────
function cmdIssues(args) {
  const label = args.find((a) => !a.startsWith("-"));
  const showAll = args.includes("--all");

  let filter = "state:open";
  if (!showAll) filter += " no:assignee";
  if (label) filter += ` label:"${label}"`;

  console.log(showAll ? "All open issues:" : "Unassigned open issues:");
  console.log("");

  const issuesJson = gh(
    `issue list --json number,title,labels,assignees --search "${filter}" --limit 30`,
  );
  const issues = JSON.parse(issuesJson);

  if (issues.length === 0) {
    console.log("  (none found)");
    return;
  }

  for (const issue of issues) {
    const labels = issue.labels.map((l) => l.name).join(", ");
    const assignees = issue.assignees.map((a) => a.login).join(", ");
    const meta = [labels && `[${labels}]`, assignees && `(${assignees})`].filter(Boolean).join(" ");
    console.log(`  #${issue.number}  ${issue.title}${meta ? `  ${meta}` : ""}`);
  }

  console.log("\nClaim one: node tools/wf.mjs claim <number>");
}

// ── issue create ───────────────────────────────────────────────────────────
// The ONLY reason this wraps `gh issue create`: it enforces the AGENTS.md
// issue/PR structure (Summary, Why/Reasoning, Decisions, Mermaid, threat model)
// so bug issues with a behavioral change don't ship without reasoning + a chart.
const ISSUE_TEMPLATE = `## Summary
<!-- 2-3 sentences: what + why. Reused as the PR summary later. -->

## Why / Reasoning
<!-- The problem, the evidence, the root cause. Not just symptoms. -->

## Decisions
<!-- User-approved choices + rejected alternatives, so reviewers don't re-ask. -->

## Trade-offs / Risks

## Flow
\`\`\`mermaid
flowchart TD
  A[before] --> B[after]
\`\`\`

## Security / threat model
<!-- Security-relevant change: what is / isn't protected. Delete if N/A. -->

## Acceptance criteria / Definition of done
<!-- Checklist an agent can verify without asking anything: which files/behaviors
     must exist, which commands must pass (npm run check), the base branch if it
     is not the default, and what exactly closes this issue. No open questions. -->
- [ ]

## Test notes
`;

// Sections every issue body must contain (interactive AND --body-file). The
// todo label is exempt: `wf todo` is quick-capture by design.
const REQUIRED_ISSUE_HEADINGS = [
  "## Summary",
  "## Why / Reasoning",
  "## Acceptance criteria / Definition of done",
];

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
}

// Single-quote a value for safe shell interpolation: POSIX single quotes
// disable ALL shell evaluation ($(), backticks, $VAR, spaces). The only char
// that can't appear literally inside single quotes is ' itself, closed-escaped-reopened.
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function flagValues(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) out.push(args[i + 1]);
  }
  return out;
}

// `wf issue`, `wf issue create`, and `wf create` all reach cmdIssueCreate.
// The bare/`create` forms are forgiving aliases so the command is hard to forget.
function cmdIssue(args) {
  cmdIssueCreate(args[0] === "create" ? args.slice(1) : args);
}

// `wf todo` = quick-capture issue, auto-labelled "todo".
function cmdTodo(args) {
  // Ensure the label exists, else `gh issue create --label todo` fails.
  // Idempotent: gh errors if it already exists, which we ignore.
  gh('label create todo --color ededed --description "Quick-capture todo"', { allowFail: true });
  const labelled = flagValues(args, "--label").includes("todo")
    ? args
    : [...args, "--label", "todo"];
  cmdIssueCreate(labelled);
}

function cmdIssueCreate(args) {
  let title = flagValue(args, "--title");
  if (!title && args[0] && !args[0].startsWith("-")) title = args[0];
  const bodyFile = flagValue(args, "--body-file");
  const labels = flagValues(args, "--label");

  let body;
  if (bodyFile) {
    // Non-interactive path (agents / scripts) — same structure, no editor.
    if (!existsSync(bodyFile)) {
      console.error(`Body file not found: ${bodyFile}`);
      process.exit(1);
    }
    body = readFileSync(bodyFile, "utf-8");
  } else {
    // Interactive: open $EDITOR on the enforced template.
    const editor = process.env.EDITOR || process.env.VISUAL;
    if (!editor) {
      console.error("No $EDITOR set. Set EDITOR, or use --body-file <path> for non-interactive.");
      process.exit(1);
    }
    const tmp = join(tmpdir(), `wf-issue-${Date.now()}.md`);
    writeFileSync(tmp, ISSUE_TEMPLATE);
    const [editorCmd, ...editorArgs] = editor.split(/\s+/);
    const res = spawnSync(editorCmd, [...editorArgs, tmp], { stdio: "inherit" });
    if (res.error) {
      console.error(`Failed to launch editor "${editor}": ${res.error.message}`);
      process.exit(1);
    }
    body = existsSync(tmp) ? readFileSync(tmp, "utf-8") : "";
    rmSync(tmp, { force: true });
    if (res.status !== 0) {
      console.error("Editor exited non-zero; aborting (no issue created).");
      process.exit(1);
    }
    if (body.trim() === "" || body.trim() === ISSUE_TEMPLATE.trim()) {
      console.error("Template unchanged or empty; aborting (no issue created).");
      process.exit(1);
    }
  }

  if (!title) {
    console.error('Missing title. Usage: wf issue create "title" [--label x] [--assignee user]...');
    process.exit(1);
  }

  if (!labels.includes("todo")) {
    const missingHeadings = REQUIRED_ISSUE_HEADINGS.filter((h) => !body.includes(h));
    if (missingHeadings.length > 0) {
      console.error(`Body is missing required section(s): ${missingHeadings.join(", ")}`);
      console.error("An issue must be workable without open questions — see the template.");
      process.exit(1);
    }
  }

  // Hand gh the body via a temp file so it is sent verbatim (no shell escaping).
  const bodyTmp = join(tmpdir(), `wf-issue-body-${Date.now()}.md`);
  writeFileSync(bodyTmp, body);
  const labelArgs = labels.map((l) => `--label ${shq(l)}`).join(" ");
  const assigneeArgs = flagValues(args, "--assignee")
    .map((a) => `--assignee ${shq(a)}`)
    .join(" ");
  const url = gh(
    `issue create --title ${shq(title)} --body-file ${shq(bodyTmp)} ${labelArgs} ${assigneeArgs}`.trim(),
  );
  rmSync(bodyTmp, { force: true });
  console.log(url);
}

// ── claim ────────────────────────────────────────────────────────────────────
function cmdClaim(args) {
  const issueNum = args[0];
  if (!issueNum || !/^\d+$/.test(issueNum)) {
    console.error("Usage: wf claim <issue-number>");
    process.exit(1);
  }

  if (isDirty()) {
    console.error("Error: Working tree is dirty. Commit or stash changes first.");
    process.exit(1);
  }

  // Fetch issue details
  console.log(`Fetching issue #${issueNum}...`);
  const issueJson = gh(`issue view ${issueNum} --json title,body,state`);
  const issue = JSON.parse(issueJson);

  if (issue.state === "CLOSED") {
    console.error(`Error: Issue #${issueNum} is already closed.`);
    process.exit(1);
  }

  // Assign issue
  const agent = getAgent();
  console.log(`Assigning issue #${issueNum} to ${agent}...`);
  gh(`issue edit ${issueNum} --add-assignee @me`, { allowFail: true });

  // Create branch
  const slug = slugify(issue.title);
  const branchName = `wf/${issueNum}-${slug}`;

  const branchExists = run(`git branch --list "${branchName}"`, { allowFail: true });
  const remoteBranchExists = run(`git ls-remote --heads origin "${branchName}"`, {
    allowFail: true,
  });

  if (branchExists) {
    console.log(`Branch ${branchName} already exists locally, checking out...`);
    run(`git checkout "${branchName}"`);
  } else if (remoteBranchExists) {
    console.log(`Branch ${branchName} exists on remote, checking out...`);
    run(`git checkout -b "${branchName}" "origin/${branchName}"`);
  } else {
    console.log(`Creating branch ${branchName} from ${PR_BASE_BRANCH}...`);
    // Explicit refspec — `git fetch origin <branch>` only updates FETCH_HEAD,
    // not refs/remotes/origin/<branch>. We need the remote-tracking ref so
    // the next-line checkout pulls from a fresh origin/<base>.
    run(`git fetch origin +${PR_BASE_BRANCH}:refs/remotes/origin/${PR_BASE_BRANCH}`, {
      allowFail: true,
    });
    run(`git checkout -b "${branchName}" "origin/${PR_BASE_BRANCH}"`);
  }

  // Generate plan file
  ensureDir(PLANS_DIR);
  const planPath = join(PLANS_DIR, `${issueNum}-${slug}.md`);

  if (existsSync(planPath)) {
    console.log(`Plan file already exists: ${planPath}`);
  } else {
    // Demote every heading in the issue body by two levels so even an
    // H1 nests under the plan's `## Issue Description` wrapper and
    // doesn't collide with the plan's own H2 sections (`## Tasks`,
    // `## Progress Log`, …). Two `#` chars are prepended, preserving
    // relative hierarchy: `# Foo` + `## Bar` + `### Baz` →
    // `### Foo` + `#### Bar` + `##### Baz`. Lines inside ``` fenced
    // code blocks are skipped so `#` comments in shell snippets aren't
    // mangled.
    let inFence = false;
    const issueBody = (issue.body || "(no description)")
      .split("\n")
      .map((line) => {
        if (/^```/.test(line)) inFence = !inFence;
        return inFence ? line : line.replace(/^(#+) /, "##$1 ");
      })
      .join("\n");
    const planContent = `# Issue #${issueNum}: ${issue.title}

> Claimed by ${agent} on ${today()}
> Branch: \`${branchName}\`

## Summary
<!-- 2-3 sentence local working summary; the PR body uses the canonical issue -->

## Issue Description
${issueBody}

## Tasks
<!-- Numbered tasks following AGENTS.md format -->

## Progress Log
| Date | Agent | Task | Status | Notes |
|------|-------|------|--------|-------|

## Handoff Notes
<!-- Current state + next steps for continuity -->
`;
    writeFileSync(planPath, planContent);
    console.log(`Created local plan: .wf/plans/${basename(planPath)}`);
  }

  console.log(`\nReady to work on issue #${issueNum}`);
  console.log(`  Branch: ${branchName}`);
  console.log(`  Plan:   .wf/plans/${basename(planPath)} (local only)`);
}

// ── lock ─────────────────────────────────────────────────────────────────────
function cmdLock(args) {
  if (args.length === 0) {
    console.error("Usage: wf lock <file...>");
    process.exit(1);
  }

  ensureDir(LOCKS_DIR);
  const agent = getAgent();
  const branch = currentBranch();
  const force = args.includes("--force");
  const files = args.filter((a) => a !== "--force");

  for (const file of files) {
    const lp = lockPath(file);
    const existing = readLock(lp);

    if (existing && !isStale(existing) && existing.agent !== agent && !force) {
      console.error(`Error: ${file} is locked by ${existing.agent} (pid ${existing.pid})`);
      console.error("  Use --force to override");
      process.exit(1);
    }

    const lock = {
      file,
      agent,
      pid: process.ppid,
      timestamp: Date.now(),
      branch,
    };
    writeFileSync(lp, JSON.stringify(lock, null, 2));
    console.log(`Locked: ${file} (agent: ${agent})`);
  }
}

// ── unlock ───────────────────────────────────────────────────────────────────
function cmdUnlock(args) {
  ensureDir(LOCKS_DIR);

  if (args.includes("--all")) {
    const locks = readdirSync(LOCKS_DIR).filter((f) => f.endsWith(".lock"));
    for (const f of locks) {
      rmSync(join(LOCKS_DIR, f));
    }
    console.log(`Released all ${locks.length} lock(s)`);
    return;
  }

  if (args.length === 0) {
    console.error("Usage: wf unlock <file...> | wf unlock --all");
    process.exit(1);
  }

  for (const file of args) {
    const lp = lockPath(file);
    if (existsSync(lp)) {
      rmSync(lp);
      console.log(`Unlocked: ${file}`);
    } else {
      console.log(`Not locked: ${file}`);
    }
  }
}

// ── locked ───────────────────────────────────────────────────────────────────
function cmdLocked() {
  ensureDir(LOCKS_DIR);
  const locks = readdirSync(LOCKS_DIR).filter((f) => f.endsWith(".lock"));

  if (locks.length === 0) {
    console.log("No files currently locked.");
    return;
  }

  console.log("Locked files:");
  for (const f of locks) {
    const lock = readLock(join(LOCKS_DIR, f));
    if (!lock) continue;
    const stale = isStale(lock) ? " (stale)" : "";
    const age = Math.round((Date.now() - lock.timestamp) / 60000);
    console.log(`  ${lock.file}  [${lock.agent}, pid ${lock.pid}, ${age}m ago]${stale}`);
  }
}

// ── status ───────────────────────────────────────────────────────────────────
function cmdStatus() {
  console.log("=== wf status ===\n");

  // Current branch
  const branch = currentBranch();
  console.log(`Branch: ${branch}`);

  // wf branches
  const wfBranches = run("git branch --list 'wf/*'", { allowFail: true });
  if (wfBranches) {
    console.log("\nWorkflow branches:");
    for (const b of wfBranches.split("\n").filter(Boolean)) {
      console.log(`  ${b.trim()}`);
    }
  }

  // Temporary local plans
  ensureDir(PLANS_DIR);
  const plans = readdirSync(PLANS_DIR).filter((f) => f.endsWith(".md"));
  if (plans.length > 0) {
    console.log("\nLocal plans:");
    for (const p of plans) {
      console.log(`  .wf/plans/${p}`);
    }
  }

  // Locks
  ensureDir(LOCKS_DIR);
  const locks = readdirSync(LOCKS_DIR).filter((f) => f.endsWith(".lock"));
  if (locks.length > 0) {
    console.log(`\nActive locks: ${locks.length}`);
    cmdLocked();
  } else {
    console.log("\nNo active locks.");
  }
}

// ── pr ───────────────────────────────────────────────────────────────────────
function cmdPr() {
  const branch = currentBranch();
  const issueNum = issueNumberFromBranch(branch);

  if (!issueNum) {
    console.error("Error: Not on a wf/* branch. Use `wf claim <issue>` first.");
    process.exit(1);
  }

  // Check for existing PR
  const existingPr = gh(`pr view "${branch}" --json url 2>/dev/null || true`, { allowFail: true });
  if (existingPr) {
    try {
      const pr = JSON.parse(existingPr);
      if (pr.url) {
        console.log(`PR already exists: ${pr.url}`);
        return;
      }
    } catch {
      // No existing PR, continue
    }
  }

  // Push branch
  console.log("Pushing branch...");
  run(`git push -u origin "${branch}"`);

  // Refresh the remote-tracking ref for the base branch so the diff below
  // reflects what's actually on origin/<base>, not a stale local copy.
  // Worktrees and long-lived branches frequently have a local `dev` that's
  // weeks behind origin/dev, which leaks unrelated files into the PR body.
  // Note: `git fetch origin <branch>` only updates FETCH_HEAD; an explicit
  // refspec is required to actually advance refs/remotes/origin/<branch>.
  run(`git fetch origin "+${PR_BASE_BRANCH}:refs/remotes/origin/${PR_BASE_BRANCH}"`, {
    allowFail: true,
  });

  // The issue is durable workflow state; local plans are disposable and never
  // become repository or PR dependencies.
  const issueJson = gh(`issue view ${issueNum} --json title,body`);
  const issue = JSON.parse(issueJson);
  const summary = extractSection(issue.body || "", "Summary");

  // Build changed files list grouped by directory.
  // Diff against origin/<base>, not the local <base>, so the file list matches
  // what GitHub will actually show on the PR.
  const diffStat = run(`git diff --stat origin/${PR_BASE_BRANCH}...HEAD`, { allowFail: true });
  const diffFiles = run(`git diff --name-only origin/${PR_BASE_BRANCH}...HEAD`, {
    allowFail: true,
  });
  const changedFiles = diffFiles ? diffFiles.split("\n").filter(Boolean) : [];

  // Group files by top-level directory
  const groups = {};
  for (const file of changedFiles) {
    const parts = file.split("/");
    const group = parts.length > 1 ? parts[0] : "(root)";
    if (!groups[group]) groups[group] = [];
    groups[group].push(file);
  }

  let changesSection = "";
  if (Object.keys(groups).length > 0) {
    const lines = [];
    for (const [group, files] of Object.entries(groups).sort()) {
      lines.push(`### ${group}/`);
      for (const f of files) {
        lines.push(`- \`${f}\``);
      }
      lines.push("");
    }
    changesSection = lines.join("\n");
  } else {
    changesSection = "(no changes yet)";
  }

  const testPlan =
    extractSection(issue.body || "", "Test notes") ||
    extractSection(issue.body || "", "Acceptance criteria / Definition of done") ||
    "<!-- Add test evidence -->";

  const body = `## Summary
${summary || "<!-- Add summary -->"}

Closes #${issueNum}

## Changes
${changesSection}
<details>
<summary>Diff stat</summary>

\`\`\`
${diffStat || "(no changes yet)"}
\`\`\`
</details>

## Test plan
${testPlan}
`;

  const prTitle = `#${issueNum}: ${issue.title}`;

  // Write body to temp file to avoid shell escaping issues
  const bodyFile = join(ROOT, ".wf", "pr-body.tmp");
  ensureDir(join(ROOT, ".wf"));
  writeFileSync(bodyFile, body);

  console.log(`Creating PR targeting ${PR_BASE_BRANCH}...`);
  const prUrl = gh(
    `pr create --base ${shq(PR_BASE_BRANCH)} --title ${shq(prTitle)} --body-file ${shq(bodyFile)}`,
  );
  rmSync(bodyFile);
  console.log(`PR created: ${prUrl}`);
}

// ── done ─────────────────────────────────────────────────────────────────────
function cmdDone() {
  ensureDir(LOCKS_DIR);
  const agent = getAgent();
  const locks = readdirSync(LOCKS_DIR).filter((f) => f.endsWith(".lock"));
  let released = 0;

  for (const f of locks) {
    const lock = readLock(join(LOCKS_DIR, f));
    if (lock && lock.agent === agent) {
      rmSync(join(LOCKS_DIR, f));
      console.log(`Released: ${lock.file}`);
      released++;
    }
  }

  const branch = currentBranch();
  const issueNum = issueNumberFromBranch(branch);
  const planPath = issueNum ? planFileForIssue(issueNum) : null;
  if (planPath) {
    const pr = currentBranchPr(branch);
    if (!pr.url) {
      console.error(
        `Error: Cannot remove the local plan until branch "${branch}" has a verified PR handoff.`,
      );
      if (pr.error) console.error(`PR lookup failed: ${pr.error}`);
      console.error(`Retained local plan: .wf/plans/${basename(planPath)}`);
      console.error(`Released ${released} lock(s) for agent "${agent}" before stopping.`);
      process.exit(1);
    }

    const repository = new URL(pr.url).pathname.split("/").slice(1, 3).join("/");
    const linkedIssues = [...pr.body.matchAll(CLOSING_KEYWORD)]
      .filter((match) => !match.groups.repository || match.groups.repository === repository)
      .map((match) => match.groups.issue);
    if (!linkedIssues.includes(issueNum)) {
      console.error(
        `Error: Cannot remove the local plan until PR ${pr.url} contains canonical closing evidence for issue #${issueNum}.`,
      );
      console.error(`Retained local plan: .wf/plans/${basename(planPath)}`);
      console.error(`Released ${released} lock(s) for agent "${agent}" before stopping.`);
      process.exit(1);
    }

    console.log(`Verified PR handoff: ${pr.url}`);
    rmSync(planPath);
    console.log(`Removed local plan: .wf/plans/${basename(planPath)}`);
  }

  console.log(`Done. Released ${released} lock(s) for agent "${agent}".`);
}

// ── archive ──────────────────────────────────────────────────────────────────
function cmdArchive(args) {
  const issueNum = args[0];
  if (!issueNum || !/^\d+$/.test(issueNum)) {
    console.error("Usage: wf archive <issue-number>");
    process.exit(1);
  }

  const planPath = planFileForIssue(issueNum);
  if (!planPath) {
    console.error(`Error: No plan file found for issue #${issueNum}`);
    process.exit(1);
  }

  rmSync(planPath);
  console.log(`Removed local plan: .wf/plans/${basename(planPath)}`);
}

// ── version validation ────────────────────────────────────────────────────────
function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`Error: version must be major.minor.patch (e.g. 0.84.0), got "${version}"`);
    process.exit(1);
  }
}

// ── release notes helper ─────────────────────────────────────────────────────
// Generate release notes from git log (commit range) instead of PR API.
// This captures exactly what's in the target ref, not what's on dev.
// `targetRef` is passed through to git verbatim — callers pass the full ref
// they want (e.g. "origin/dev" for an RC PR body, or a merge SHA for a
// release that's already landed).
function generateReleaseNotesFromRange(sinceTag, targetRef) {
  // Extract PR numbers from commits in the range. We deliberately do NOT pass
  // --merges here: under squash-merge or rebase-and-merge, GitHub produces
  // ordinary (non-merge) commits with subjects like `feat: add foo (#123)`,
  // and --merges would skip them entirely → empty release notes.
  // We match these three forms:
  //   - merge commit:    `Merge pull request #123 from ...`
  //   - squash-merge:    `feat: add foo (#123)`
  //   - explicit PR ref: `PR #123: ...` or `Fix from PR #123`
  // Free-floating `#N` (e.g. review-iteration markers like "round 2 #2" in a
  // commit subject) is intentionally excluded — it would otherwise resolve to
  // an unrelated historical PR and pollute the release notes.
  run("git fetch origin --tags", { allowFail: true });
  const logOutput = run(`git log ${sinceTag}..${targetRef} --oneline`, {
    allowFail: true,
  });

  if (!logOutput) return "(no changes found)";

  const prNumbers = new Set();
  for (const line of logOutput.split("\n").filter(Boolean)) {
    const matches = line.matchAll(/(?:pull request #|\(#|PR #)(\d+)/g);
    for (const m of matches) {
      prNumbers.add(m[1]);
    }
  }

  if (prNumbers.size === 0) return "(no changes found)";

  // Fetch PR details for each
  const prs = [];
  for (const num of prNumbers) {
    const prJson = gh(`pr view ${num} --json number,title,headRefName`, { allowFail: true });
    if (prJson) {
      try {
        prs.push(JSON.parse(prJson));
      } catch {}
    }
  }

  if (prs.length === 0) return "(no changes found)";

  // Filter out release branches and promotion / backport PRs
  const filteredPrs = prs.filter((pr) => {
    const title = pr.title.toLowerCase();
    if (title.startsWith("backport") || title.startsWith("rc v") || title.startsWith("release v")) {
      return false;
    }
    if (pr.headRefName?.startsWith("release/")) return false;
    return true;
  });

  if (filteredPrs.length === 0) return "(no changes found)";

  // Categorize
  const features = [];
  const fixes = [];
  const maintenance = [];

  for (const pr of filteredPrs) {
    const title = pr.title.toLowerCase();
    if (title.startsWith("feat")) {
      features.push(pr);
    } else if (title.startsWith("fix")) {
      fixes.push(pr);
    } else {
      maintenance.push(pr);
    }
  }

  // Format
  const sections = [];
  if (features.length > 0) {
    sections.push(
      `### Features\n${features.map((pr) => `- #${pr.number}: ${pr.title}`).join("\n")}`,
    );
  }
  if (fixes.length > 0) {
    sections.push(`### Fixes\n${fixes.map((pr) => `- #${pr.number}: ${pr.title}`).join("\n")}`);
  }
  if (maintenance.length > 0) {
    sections.push(
      `### Maintenance\n${maintenance.map((pr) => `- #${pr.number}: ${pr.title}`).join("\n")}`,
    );
  }

  return sections.join("\n\n");
}

// ── rc ───────────────────────────────────────────────────────────────────────
function cmdRc(args) {
  const version = args[0];
  if (!version) {
    console.error("Usage: wf rc <version>  (e.g. wf rc 0.84.0)");
    process.exit(1);
  }
  validateVersion(version);

  // Refuse to run with a dirty working tree — stray edits would ride into the release branch.
  // (Stash is a destructive operation per repo policy; do not suggest it.)
  const dirty = run("git status --porcelain", { allowFail: true });
  if (dirty) {
    console.error(
      "Error: Working directory has uncommitted changes — commit them, or move them to another worktree, before cutting a release.",
    );
    process.exit(1);
  }

  // Capture the starting branch so a failed push can roll back cleanly to here.
  // Detached HEAD has nowhere to return to, which would orphan the new release
  // branch on rollback — refuse up front.
  const originalBranch = currentBranch();
  if (!originalBranch) {
    console.error(
      "Error: wf rc must be run from a branch (detached HEAD has nowhere to roll back to on push failure).",
    );
    console.error("Check out dev (or any branch) and re-run.");
    process.exit(1);
  }

  // Fetch origin/dev + tags BEFORE we read any refs. Without this, a stale
  // local tag list can pick the wrong "last release tag" and stale origin/dev
  // can produce wrong release notes. The explicit refspec is required: bare
  // `git fetch origin dev` only updates FETCH_HEAD, leaving refs/remotes/
  // origin/dev stale on long-lived clones/worktrees.
  console.log("Fetching origin/dev and tags...");
  run("git fetch origin +dev:refs/remotes/origin/dev --tags");

  const branch = `release/v${version}`;

  // Refuse to clobber an existing branch — local or remote. Without the
  // remote check, this command would create a local release/v* and only
  // fail at push when the remote branch already exists.
  const localExists = run(`git rev-parse --verify ${branch}`, { allowFail: true });
  if (localExists) {
    console.error(`Error: branch ${branch} already exists locally.`);
    console.error(`Delete it first if you intend to recreate it: git branch -D ${branch}`);
    process.exit(1);
  }
  const remoteExists = run(`git ls-remote --heads origin ${branch}`, { allowFail: true });
  if (remoteExists) {
    console.error(`Error: branch ${branch} already exists on origin.`);
    console.error(
      `Delete it on origin if you intend to recreate it: git push origin --delete ${branch}`,
    );
    process.exit(1);
  }

  // Find last release tag (exclude rc tags). Reads from local tags, which we
  // just refreshed above.
  const allTags = run('git tag -l "v*" --sort=-v:refname', { allowFail: true });
  const lastReleaseTag = allTags
    .split("\n")
    .filter(Boolean)
    .find((t) => !t.includes("-rc."));

  if (!lastReleaseTag) {
    console.error("Error: No release tags found (v* pattern).");
    process.exit(1);
  }

  console.log(`Last release tag: ${lastReleaseTag}`);
  console.log("Generating release notes from origin/dev...");

  // Release notes from PRs merged to dev since the last release
  const notes = generateReleaseNotesFromRange(lastReleaseTag, "origin/dev");

  console.log(`Creating release branch ${branch} from origin/dev...`);
  run(`git checkout -b ${branch} origin/dev`);

  // Validate and bump against the new branch (working tree IS origin/dev now).
  // Reading appVersion before checkout would compare against the operator's
  // previous tree — pre-bumped, stale, or unrelated. Any rejection here rolls
  // back the new branch so the next run isn't blocked by localExists.
  try {
    const configPath = join(ROOT, "app.config.ts");
    const configSource = readFileSync(configPath, "utf8");
    const currentVersionMatch = configSource.match(/const\s+appVersion\s*=\s*"([\d.]+)";/);
    const currentVersion = currentVersionMatch?.[1];
    if (!currentVersion) {
      throw new Error("could not read appVersion from app.config.ts on origin/dev");
    }
    if (currentVersion === version) {
      console.log(`appVersion already at ${version}, skipping bump.`);
    } else {
      console.log(`Bumping appVersion ${currentVersion} -> ${version}...`);
      const bumpScript = join(ROOT, "scripts/bump-version.mjs");
      // --json emits a single JSON line on stdout describing what the bump
      // would do. Parse that instead of regex-matching human-readable output.
      const dryRunOutput = run(`node ${bumpScript} --dry-run --json`);
      let computed;
      try {
        computed = JSON.parse(dryRunOutput).nextVersion;
      } catch {
        throw new Error(`could not parse bump-version dry-run output as JSON:\n${dryRunOutput}`);
      }
      if (computed !== version) {
        throw new Error(
          `minor bump from ${currentVersion} would produce ${computed}, not ${version}.\nEither:\n  (a) Run \`wf rc ${computed}\` to use the computed minor bump, or\n  (b) Bump app.config.ts to ${version} manually first, then re-run.`,
        );
      }
      run(`node ${bumpScript}`);
      run("git add app.config.ts");
      run(`git commit -m "chore: bump appVersion to ${version}"`);
    }
  } catch (e) {
    run(`git checkout ${originalBranch}`, { allowFail: true });
    run(`git branch -D ${branch}`, { allowFail: true });
    console.error(`Error: ${e.message}`);
    console.error("\nLocal release branch rolled back.");
    process.exit(1);
  }

  // Wrap the push so a transient network/auth/protection failure rolls back
  // the new local branch (and its bump commit), keeping `wf rc <version>`
  // idempotent — the operator can simply re-run.
  console.log(`Pushing ${branch} to origin...`);
  try {
    execSync(`git push -u origin ${branch}`, { cwd: ROOT, stdio: "pipe" });
  } catch (e) {
    const stderr = e.stderr?.toString().trim() || e.message;
    run(`git checkout ${originalBranch}`, { allowFail: true });
    run(`git branch -D ${branch}`, { allowFail: true });
    console.error(`Error: failed to push ${branch} to origin.`);
    console.error(stderr);
    console.error(
      `\nLocal branch rolled back. Fix the push issue and re-run \`wf rc ${version}\`.`,
    );
    process.exit(1);
  }

  const title = `RC v${version}`;
  const body = `## Release Candidate v${version}

${notes}

## Next steps

- \`appVersion\` already bumped to \`${version}\` on this branch (\`versionCode\` / \`buildNumber\` are remote-managed; \`package.json#version\` is unused at runtime — do not touch it).
- Preview OTA auto-publishes on every push to this branch — QA tests on the \`preview\` channel.
- Fix any QA blockers directly on \`${branch}\`.
- After this PR merges to \`main\`, run \`wf release ${version}\` to open the backport PR to \`dev\` and tag \`main\` with \`v${version}\`.
`;

  // Write body to temp file to avoid shell escaping issues
  const bodyFile = join(ROOT, ".wf", "pr-body.tmp");
  ensureDir(join(ROOT, ".wf"));
  writeFileSync(bodyFile, body);

  // Wrap PR creation so a failure here (transient network/auth, API rate limit,
  // "no commits in branch") rolls back the just-pushed remote branch and the
  // local branch+bump commit — otherwise the remoteExists preflight aborts the
  // re-run, breaking idempotency.
  console.log(`Creating ${branch} → main PR...`);
  let prUrl;
  try {
    prUrl = execSync(
      `gh pr create --base "main" --head ${shq(branch)} --title ${shq(title)} --body-file ${shq(bodyFile)}`,
      { cwd: ROOT, stdio: "pipe", encoding: "utf-8" },
    )
      .toString()
      .trim();
  } catch (e) {
    const stderr = e.stderr?.toString().trim() || e.message;
    // Track whether the remote delete actually succeeded. `git push origin
    // --delete` may fail for the same reason PR creation failed (auth, network,
    // rate limit) — without checking we'd report "remote branch rolled back"
    // even when the remote branch is still there, then the next run aborts at
    // the remoteExists preflight.
    let remoteDeleted = false;
    try {
      execSync(`git push origin --delete ${branch}`, { cwd: ROOT, stdio: "pipe" });
      remoteDeleted = true;
    } catch {}
    run(`git checkout ${originalBranch}`, { allowFail: true });
    run(`git branch -D ${branch}`, { allowFail: true });
    console.error(`Error: failed to create ${branch} → main PR.`);
    console.error(stderr);
    if (remoteDeleted) {
      console.error(
        `\nLocal and remote branch rolled back. Fix the PR-creation issue and re-run \`wf rc ${version}\`.`,
      );
    } else {
      console.error(
        "\nLocal branch rolled back, but remote branch deletion failed (likely the same auth/network cause). Verify and delete manually:",
      );
      console.error(`  git ls-remote --heads origin ${branch}`);
      console.error(`  git push origin --delete ${branch}`);
      console.error(`Then re-run \`wf rc ${version}\`.`);
    }
    process.exit(1);
  }
  rmSync(bodyFile);

  console.log(`\nRC PR created: ${prUrl}`);
  console.log("\nNext steps:");
  console.log(`  1. Preview OTA auto-publishes on push to ${branch}.`);
  console.log(`  2. QA tests on the preview channel; push fixes directly to ${branch}.`);
  console.log(`  3. After merge to main, run: wf release ${version}`);
}

// ── release ──────────────────────────────────────────────────────────────────
function cmdRelease(args) {
  const version = args[0];
  if (!version) {
    console.error("Usage: wf release <version>  (e.g. wf release 0.84.0)");
    process.exit(1);
  }
  validateVersion(version);

  const branch = `release/v${version}`;

  console.log("Fetching origin...");
  run("git fetch origin", { allowFail: true });

  // Preflight: locate the merged RC PR for this version, capture its merge SHA.
  //
  // We don't use `git merge-base --is-ancestor origin/${branch} origin/main`
  // because that only returns true for plain merge commits. Squash-merge and
  // rebase-merge produce new commits that aren't ancestors of the RC branch
  // head — so an ancestor check would falsely reject legitimate squash-merged
  // releases. It would also bind the tag to wherever `origin/main` is right
  // now, which may have moved past the RC merge.
  //
  // Asking GitHub for the merged PR gives us mergeCommit.oid, which is the
  // exact commit the RC landed as regardless of merge strategy (PR.mergeCommit
  // works for merge commit / squash / rebase). We tag that SHA specifically.
  const rcPrJson = gh(
    `pr list --base main --head ${branch} --state merged --json number,mergeCommit --limit 1`,
    { allowFail: true },
  );
  let mergedSha = null;
  let rcPrNumber = null;
  try {
    const arr = JSON.parse(rcPrJson || "[]");
    if (arr.length > 0) {
      rcPrNumber = arr[0].number;
      mergedSha = arr[0].mergeCommit?.oid ?? null;
    }
  } catch {}
  if (!mergedSha) {
    console.error(`Error: no merged PR found from ${branch} into main.`);
    console.error("Either:");
    console.error(`  (a) The RC PR was never created — run \`wf rc ${version}\` first, or`);
    console.error(
      `  (b) The RC PR exists but hasn't merged into main yet — merge it, then re-run.`,
    );
    process.exit(1);
  }
  console.log(`Found merged RC PR #${rcPrNumber} → main at ${mergedSha.slice(0, 7)}`);

  // Preflight: verify app.config.ts at the merge SHA actually contains the
  // requested appVersion. Without this, a mistaken release branch (or a stale
  // rebase that dropped the version-bump commit) could be tagged as v0.84.0
  // while the shipped binary's appVersion is something else — a silent
  // store-version-mismatch trap.
  //
  // We `git show ${mergedSha}:app.config.ts` so we don't need to check out the
  // commit — the working tree stays on whatever branch the operator is on.
  run(`git fetch origin ${mergedSha}`, { allowFail: true });
  const configAtMerge = run(`git show ${mergedSha}:app.config.ts`, { allowFail: true });
  if (!configAtMerge) {
    console.error(`Error: could not read app.config.ts at ${mergedSha.slice(0, 7)}.`);
    process.exit(1);
  }
  const versionAtMerge = configAtMerge.match(/const\s+appVersion\s*=\s*"([\d.]+)";/)?.[1];
  if (!versionAtMerge) {
    console.error(`Error: could not find appVersion in app.config.ts at ${mergedSha.slice(0, 7)}.`);
    process.exit(1);
  }
  if (versionAtMerge !== version) {
    console.error(
      `Error: appVersion at merge SHA ${mergedSha.slice(0, 7)} is "${versionAtMerge}", not "${version}".`,
    );
    console.error(
      `The release branch was tagged as v${version} but ships appVersion ${versionAtMerge} — refusing to create a tag/version mismatch.`,
    );
    console.error(
      `Either run \`wf release ${versionAtMerge}\`, or fix the bump on the release branch and re-merge.`,
    );
    process.exit(1);
  }
  console.log(`Verified appVersion ${version} at merge SHA.`);

  // Preflight: tag must not already exist (local or remote).
  const localTagSha = run(`git rev-parse --verify v${version}`, { allowFail: true });
  if (localTagSha) {
    console.error(`Error: tag v${version} already exists locally.`);
    process.exit(1);
  }
  const remoteTag = run(`git ls-remote --tags origin v${version}`, { allowFail: true });
  if (remoteTag) {
    console.error(`Error: tag v${version} already exists on origin.`);
    process.exit(1);
  }

  // Capture the prior release tag BEFORE we create the new one, so release-notes
  // generation reads from the truly-previous release to origin/main.
  const allTags = run('git tag -l "v*" --sort=-v:refname', { allowFail: true });
  const previousReleaseTag = allTags
    .split("\n")
    .filter(Boolean)
    .find((t) => !t.includes("-rc."));

  // Preflight: create the tag locally and dry-run push it to confirm the operator
  // has permission to push to refs/tags/v*. Some orgs block tag creation via
  // branch protection rules; without this check, we'd discover the failure
  // AFTER opening the backport PR — leaving an orphan PR + half-finished
  // release state. Dry-run pushes still trigger server-side protection rules,
  // so a 403 here means the real push would also fail.
  console.log(`Preflight: creating local tag v${version} and dry-run pushing...`);
  run(`git fetch origin ${mergedSha} --tags`, { allowFail: true });
  run(`git tag -a v${version} -m "Release v${version}" ${mergedSha}`);
  try {
    execSync(`git push --dry-run origin v${version}`, { cwd: ROOT, stdio: "pipe" });
  } catch (e) {
    run(`git tag -d v${version}`, { allowFail: true });
    const stderr = e.stderr?.toString().trim() || e.message;
    console.error(`Error: cannot push tag v${version} to origin.`);
    console.error(stderr);
    console.error(
      "\nLikely causes: missing push permission, branch protection on v* tags, or network issue.",
    );
    console.error("Local tag rolled back. Fix permissions and re-run.");
    process.exit(1);
  }
  console.log("Tag push permissions OK.");

  // 1. Backport PR: release/v<version> → dev
  const backportTitle = `Backport v${version} to dev`;
  const backportBody = `## Backport v${version} to dev

Merges bug fixes and version bumps from \`${branch}\` back into \`dev\` so the
release branch and \`dev\` stay in sync after \`v${version}\` ships.

Created automatically by \`wf release ${version}\`.
`;

  const bodyFile = join(ROOT, ".wf", "pr-body.tmp");
  ensureDir(join(ROOT, ".wf"));
  writeFileSync(bodyFile, backportBody);

  // Count commits to backport using mergedSha directly. The remote-tracking
  // ref refs/remotes/origin/${branch} may be stale (long-lived clones don't
  // auto-advance it) or missing entirely (auto-delete-on-merge repos drop
  // the branch when the RC PR merges). mergedSha is the authoritative
  // reference for what landed on main and was fetched earlier.
  const backportCommitCount = run(`git rev-list --count origin/dev..${mergedSha}`, {
    allowFail: true,
  });
  const hasBackportableCommits = backportCommitCount !== "" && Number(backportCommitCount) > 0;

  let backportPrUrl = null;
  if (!hasBackportableCommits) {
    console.log(
      `No commits between origin/dev and ${mergedSha.slice(0, 7)} — skipping backport PR (nothing to merge back).`,
    );
    rmSync(bodyFile);
  } else {
    // Auto-delete-on-merge repos drop the release branch the moment the RC
    // PR merges into main, but the backport PR needs ${branch} as its head.
    // Recreate it from the original release-branch tip, NOT from mergedSha
    // directly: when the RC PR was merged with the "create a merge commit"
    // strategy, mergedSha is a 2-parent merge commit whose first-parent
    // ancestry goes through main — pushing it as the branch tip would
    // include unrelated main commits in the subsequent backport diff.
    // mergedSha^2 (the second parent) is the original release tip. For
    // squash/rebase merges, mergedSha has only one parent and mergedSha^2
    // doesn't resolve, so fall back to mergedSha (which IS the release-
    // equivalent commit in those strategies).
    const remoteRef = run(`git ls-remote --heads origin ${branch}`, { allowFail: true });
    if (!remoteRef) {
      const releaseTipSha =
        run(`git rev-parse --verify ${mergedSha}^2`, { allowFail: true }) || mergedSha;
      console.log(
        `Branch ${branch} was deleted post-merge — recreating from ${releaseTipSha.slice(0, 7)} for the backport PR...`,
      );
      run(`git push origin ${releaseTipSha}:refs/heads/${branch}`);
    }

    // Wrap PR creation so a failure here (auth, network, PR-already-exists)
    // rolls back the preflight-created local tag — otherwise the tag preflight
    // on the next run would abort and require manual `git tag -d`.
    console.log(`Creating backport PR ${branch} → dev...`);
    try {
      backportPrUrl = execSync(
        `gh pr create --base "dev" --head ${shq(branch)} --title ${shq(backportTitle)} --body-file ${shq(bodyFile)}`,
        { cwd: ROOT, stdio: "pipe", encoding: "utf-8" },
      )
        .toString()
        .trim();
    } catch (e) {
      run(`git tag -d v${version}`, { allowFail: true });
      const stderr = e.stderr?.toString().trim() || e.message;
      console.error(`Error: failed to create backport PR ${branch} → dev.`);
      console.error(stderr);
      console.error(
        `\nLocal tag v${version} rolled back. Fix the backport PR creation issue and re-run \`wf release ${version}\`.`,
      );
      process.exit(1);
    }
    rmSync(bodyFile);
    console.log(`Backport PR created: ${backportPrUrl}`);
  }

  // 2. Push the tag created in the preflight step above. The tag points at
  // the merge SHA (not origin/main), so it captures the exact commit the RC
  // PR landed as even if main has moved past it.
  console.log(`\nPushing tag v${version} (${mergedSha.slice(0, 7)})...`);
  try {
    execSync(`git push origin v${version}`, { cwd: ROOT, stdio: "pipe" });
  } catch (e) {
    const stderr = e.stderr?.toString().trim() || e.message;
    console.error(`Error: failed to push tag v${version} to origin.`);
    console.error(stderr);
    if (backportPrUrl) {
      console.error(
        `\nLocal tag v${version} (${mergedSha.slice(0, 7)}) preserved — re-running \`wf release\` would fail because the backport PR already exists (${backportPrUrl}), so recover manually:`,
      );
    } else {
      console.error(
        `\nLocal tag v${version} (${mergedSha.slice(0, 7)}) preserved. No backport PR was created (no commits to backport), so recover manually:`,
      );
    }
    console.error(`  git push origin v${version}`);
    console.error("Once the tag is pushed, create the GitHub Release manually if needed:");
    console.error(
      `  gh release create v${version} --title "v${version}" --generate-notes --target ${mergedSha}`,
    );
    process.exit(1);
  }
  console.log(`Tag v${version} pushed to origin.`);

  // 3. Create the GitHub Release with auto-generated notes.
  // Release notes range upper bound is the merge SHA, not origin/main —
  // anything merged into main after the RC landed belongs to the next release.
  let releaseCreated = false;
  if (previousReleaseTag) {
    console.log(
      `\nGenerating release notes from ${previousReleaseTag} to ${mergedSha.slice(0, 7)}...`,
    );
    const releaseNotes = generateReleaseNotesFromRange(previousReleaseTag, mergedSha);
    const notesFile = join(ROOT, ".wf", "release-notes.tmp");
    writeFileSync(notesFile, releaseNotes);
    console.log(`Creating GitHub Release v${version}...`);
    const releaseUrl = gh(
      `release create v${version} --title "v${version}" --notes-file "${notesFile}" --target ${mergedSha}`,
      { allowFail: true },
    );
    rmSync(notesFile);
    if (releaseUrl) {
      console.log(`GitHub Release created: ${releaseUrl}`);
      releaseCreated = true;
    } else {
      console.error("Warning: GitHub Release creation failed.");
      console.error(
        `Run manually: gh release create v${version} --title "v${version}" --generate-notes --target ${mergedSha}`,
      );
    }
  } else {
    console.error("Warning: no prior release tag found — skipping GitHub Release creation.");
  }

  console.log("\nNext steps:");
  if (backportPrUrl) {
    console.log(`  1. Review and merge the backport PR: ${backportPrUrl}`);
    console.log(`  2. Delete the ${branch} branch once the backport is merged.`);
    console.log("  3. Trigger an EAS production build from main.");
  } else {
    console.log(`  1. Delete the ${branch} branch if it still exists on origin.`);
    console.log("  2. Trigger an EAS production build from main.");
  }
  if (!releaseCreated) {
    console.log("  4. Create the GitHub Release manually (see warning above).");
  }
}

// ── help ─────────────────────────────────────────────────────────────────────
function cmdHelp() {
  console.log(`wf — Multi-agent workflow CLI

Commands:
  wf issues              List unassigned open issues (--all for all, <label> to filter)
  wf issue create        Create an issue from the enforced AGENTS.md template
  wf issue / wf create   Same as 'issue create' (forgiving aliases)
  wf todo                Quick-capture issue, auto-labelled "todo"
  wf claim <issue>       Assign issue, create branch, generate a temporary local plan
  wf lock <file...>      Lock file(s) before editing (--force to override)
  wf unlock <file...>    Release lock(s) after editing
  wf unlock --all        Release ALL locks (stale cleanup)
  wf locked              List all locked files + stale detection
  wf status              Show branches and local workflow state
  wf pr                  Push + create PR referencing issue
  wf rc <version>        Cut release/v<version> from dev and open RC PR to main
  wf release <version>   Open backport PR release/v<version>→dev and tag main with v<version>
  wf done                Release your locks and remove the current local plan
  wf archive <issue>     Remove a local plan (legacy command)
  wf help                Print this help

Environment:
  WF_AGENT               Agent identity (default: $USER)

Examples:
  wf issues              List available issues to work on
  wf issues bug           List unassigned issues labeled "bug"
  wf issues --all        List all open issues (including assigned)
  wf issue create "Title" --label bug         Open $EDITOR on the template, then create
  wf issue create --title "Title" --body-file b.md --label bug   Non-interactive (agents)
  wf issue create "Title" --assignee taner-caliskan   Assign on creation (small, well-defined issues)
  wf claim 42            Claim issue #42, create branch wf/42-..., generate plan
  wf lock screens/CardScreen.tsx lib/utils.ts
  wf unlock screens/CardScreen.tsx
  wf pr                  Push and create PR from current wf/* branch
`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "issues":
    cmdIssues(args);
    break;
  case "issue":
  case "create":
    cmdIssue(args);
    break;
  case "todo":
    cmdTodo(args);
    break;
  case "claim":
    cmdClaim(args);
    break;
  case "lock":
    cmdLock(args);
    break;
  case "unlock":
    cmdUnlock(args);
    break;
  case "locked":
    cmdLocked();
    break;
  case "status":
    cmdStatus();
    break;
  case "pr":
    cmdPr();
    break;
  case "rc":
    cmdRc(args);
    break;
  case "release":
    cmdRelease(args);
    break;
  case "done":
    cmdDone();
    break;
  case "archive":
    cmdArchive(args);
    break;
  case "help":
  case "--help":
  case "-h":
    cmdHelp();
    break;
  default:
    if (command) console.error(`Unknown command: ${command}\n`);
    cmdHelp();
    if (command) process.exit(1);
    break;
}
