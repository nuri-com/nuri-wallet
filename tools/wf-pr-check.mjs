#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CLOSING_KEYWORD =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:(?<repository>[a-z0-9_.-]+\/[a-z0-9_.-]+))?#(?<issue>\d+)\b/gi;

export async function checkWfPullRequest({ event, fetchImpl = fetch, apiUrl, token }) {
  const pullRequest = event.pull_request;
  const repository = event.repository?.full_name;
  const branch = pullRequest?.head?.ref;

  if (!pullRequest || !repository || !branch) {
    throw new Error("Pull request event is missing repository or branch data.");
  }

  const branchMatch = branch.match(/^wf\/(\d+)-[a-z0-9][a-z0-9-]*$/);
  if (!branchMatch) {
    throw new Error(`Branch "${branch}" must match wf/<issue-number>-<slug>.`);
  }
  const issueNumber = branchMatch[1];
  const response = await fetchImpl(`${apiUrl}/repos/${repository}/issues/${issueNumber}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Issue #${issueNumber} does not exist or is not accessible (${response.status}).`,
    );
  }

  const issue = await response.json();
  if (issue.pull_request) {
    throw new Error(`#${issueNumber} is a pull request, not the canonical issue.`);
  }

  const linkedIssues = [...(pullRequest.body || "").matchAll(CLOSING_KEYWORD)]
    .filter((match) => !match.groups.repository || match.groups.repository === repository)
    .map((match) => match.groups.issue);
  if (!linkedIssues.includes(issueNumber)) {
    throw new Error(
      `PR body must contain canonical closing evidence for issue #${issueNumber} (for example: Closes #${issueNumber}).`,
    );
  }

  return { branch, issueNumber };
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const apiUrl = process.env.GITHUB_API_URL;
  const token = process.env.GITHUB_TOKEN;
  if (!eventPath || !apiUrl || !token) {
    throw new Error("GITHUB_EVENT_PATH, GITHUB_API_URL, and GITHUB_TOKEN are required.");
  }

  const event = JSON.parse(readFileSync(eventPath, "utf-8"));
  const result = await checkWfPullRequest({ event, apiUrl, token });
  console.log(
    `Verified ${result.branch}: canonical issue #${result.issueNumber} exists and is linked.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
