#!/usr/bin/env node
// metro-log-capture.mjs — tee the dev client's console output to a file.
// Attaches to Metro's inspector proxy (CDP over WebSocket), enables the
// Runtime domain and appends every consoleAPICalled event with a timestamp.
// Usage: node tools/metro-log-capture.mjs <outfile>   (Metro on :8081, Node 22+)
import { appendFileSync } from "node:fs";

const out = process.argv[2];
if (!out) {
  console.error("usage: node tools/metro-log-capture.mjs <outfile>");
  process.exit(1);
}

const targets = await (await fetch("http://localhost:8081/json")).json();
const page =
  targets.find(
    (t) => t.webSocketDebuggerUrl && /Hermes|Experimental/i.test(String(t.title ?? "")),
  ) ?? targets.find((t) => t.webSocketDebuggerUrl);
if (!page) {
  console.error("no debuggable target on :8081 — is the dev client running?");
  process.exit(1);
}
console.error(`attaching to "${page.title}" → ${out}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
ws.onmessage = (event) => {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }
  if (msg.method !== "Runtime.consoleAPICalled") return;
  const text = (msg.params.args ?? [])
    .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? "")))
    .join(" ");
  appendFileSync(out, `${new Date().toISOString()} [${msg.params.type}] ${text}\n`);
};
ws.onclose = () => {
  console.error("inspector socket closed (app reloaded? re-run to re-attach)");
  process.exit(0);
};
ws.onerror = (e) => {
  console.error("ws error:", e?.message ?? e);
  process.exit(1);
};
