// HTTP transport for the arkade remote signer. Owns URL/header building,
// payload parsing, trace logging, and the fetch/post/get wrappers. Stateless
// apart from the injected accessors — base URL + auth come from
// arkadeServerConfigService at call time (not construction time) and the
// in-flight approval state used for trace formatting is read through an
// injected accessor so this module does not depend back on
// ArkadeRemoteIdentity.
import { errMsg } from "../../../lib/errorMessage";
import { shortTime } from "../../../lib/logShared";
import { arkadeServerConfigService } from "../ArkadeServerConfigService";
import { ARKADE_CLIENT_VERSION, ARKADE_SDK_HINT } from "../ArkadeVersion";
import type { ArkadeSpendApprovalScope } from "./spendApproval";

type ArkadeSignerApprovalScope =
  | ArkadeSpendApprovalScope
  | "receive_claim"
  | "boarding_sweep"
  | "recoverable_wallet_update";

type ApprovalTraceState = {
  state: string | null;
  approvalScope: ArkadeSignerApprovalScope;
} | null;

function normalizeHex(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function shortRef(value: string, head = 8, tail = 4): string {
  const raw = String(value || "").trim();
  if (!raw) return "n/a";
  if (tail <= 0) {
    return raw.length <= head ? raw : `${raw.slice(0, head)}...`;
  }
  if (raw.length <= head + tail + 3) return raw;
  return `${raw.slice(0, head)}...${raw.slice(-tail)}`;
}

export class SignerHttpClient {
  constructor(private readonly getApprovalTraceState: () => ApprovalTraceState) {}

  buildSignerUrl(path: string): string {
    const base = arkadeServerConfigService.getSignerServerUrl().replace(/\/+$/, "");
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${base}${normalizedPath}`;
  }

  buildSignerHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Arkade-Client": ARKADE_CLIENT_VERSION,
      "X-Arkade-Sdk": ARKADE_SDK_HINT,
    };
    return headers;
  }

  parseSignerPayload(body: RequestInit["body"]): Record<string, unknown> | null {
    if (typeof body !== "string" || !body.trim()) {
      return null;
    }
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  buildSignerTraceContext(payload: Record<string, unknown> | null): string {
    if (!payload) return "";
    const parts: string[] = [];
    const approval = this.getApprovalTraceState();
    const state =
      typeof payload.state === "string" && payload.state.trim()
        ? payload.state
        : payload.approval_token
          ? approval?.state || ""
          : "";
    if (payload.approval_token) {
      parts.push("approval=1");
      if (approval?.approvalScope) {
        parts.push(`scope=${approval.approvalScope}`);
      }
    }
    if (state) {
      parts.push(`state=${shortRef(state)}`);
    }
    if (typeof payload.session_id === "string" && payload.session_id.trim()) {
      parts.push(`session=${shortRef(payload.session_id)}`);
    }
    if (typeof payload.txid === "string" && payload.txid.trim()) {
      parts.push(`txid=${shortRef(payload.txid, 12, 8)}`);
    }
    if (Array.isArray(payload.txids) && payload.txids.length > 0) {
      parts.push(`txids=${payload.txids.length}`);
    }
    if (Array.isArray(payload.sign_requests) && payload.sign_requests.length > 0) {
      parts.push(`requests=${payload.sign_requests.length}`);
    }
    if (typeof payload.approval_scope === "string" && payload.approval_scope.trim()) {
      parts.push(`requestScope=${payload.approval_scope}`);
    }
    if (typeof payload.client_pk33 === "string" && payload.client_pk33.trim()) {
      parts.push(`clientPk=${shortRef(normalizeHex(payload.client_pk33), 10, 6)}`);
    }
    if (typeof payload.client_signer_pubkey === "string" && payload.client_signer_pubkey.trim()) {
      parts.push(`clientSigner=${shortRef(normalizeHex(payload.client_signer_pubkey), 10, 6)}`);
    }
    if (typeof payload.msg32 === "string" && payload.msg32.trim()) {
      parts.push(`msg=${shortRef(normalizeHex(payload.msg32), 12, 8)}`);
    }
    if (typeof payload.tweak32 === "string" && payload.tweak32.trim()) {
      parts.push(`tweak=${shortRef(normalizeHex(payload.tweak32), 12, 8)}`);
    }
    if (typeof payload.client_pub_nonce === "string" && payload.client_pub_nonce.trim()) {
      parts.push(`pubNonce=${shortRef(normalizeHex(payload.client_pub_nonce), 12, 8)}`);
    }
    if (typeof payload.outer_agg_nonce66 === "string" && payload.outer_agg_nonce66.trim()) {
      parts.push(`outerNonce=${shortRef(normalizeHex(payload.outer_agg_nonce66), 12, 8)}`);
    }
    return parts.join(" ");
  }

  logSignerHttp(
    op: string,
    method: string,
    path: string,
    status: string | number,
    durMs: number,
    traceContext: string,
    reason?: string,
  ): void {
    const parts = [
      `🔐 [${shortTime()} ArkadeRemoteIdentity.http]`,
      `op=${op}`,
      `method=${method}`,
      `path=${path}`,
      `status=${status}`,
      `durMs=${durMs}`,
    ];
    if (traceContext) {
      parts.push(traceContext);
    }
    if (reason) {
      parts.push(`reason=${shortRef(reason, 40, 0)}`);
    }
    console.log(parts.join(" "));
  }

  async fetchSignerJson<T>(op: string, path: string, init: RequestInit): Promise<T> {
    const url = this.buildSignerUrl(path);
    const method = String(init.method || "GET").toUpperCase();
    const tracePath = (() => {
      try {
        const parsed = new URL(url);
        return `${parsed.pathname}${parsed.search || ""}`;
      } catch {
        return path;
      }
    })();
    const tracePayload = this.parseSignerPayload(init.body);
    const traceContext = this.buildSignerTraceContext(tracePayload);
    const startedAtMs = Date.now();
    let response: Response;
    // Merge headers via the Headers API so a caller passing Headers /
    // string[][] / Record<string, string> all behave identically. A naive
    // spread of `init.headers` is only safe for the record form.
    const mergedHeaders = new Headers(this.buildSignerHeaders());
    if (init.headers) {
      new Headers(init.headers).forEach((value, key) => {
        mergedHeaders.set(key, value);
      });
    }
    try {
      response = await fetch(url, { ...init, headers: mergedHeaders });
    } catch (error: unknown) {
      this.logSignerHttp(
        op,
        method,
        tracePath,
        "ERR",
        Date.now() - startedAtMs,
        traceContext,
        errMsg(error, "fetch_failed"),
      );
      throw error;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {}
      const parsedRecord =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      const parsedError =
        parsedRecord && typeof parsedRecord.error === "string" ? parsedRecord.error : "";
      const message = parsedError || (text ? text.slice(0, 220) : `HTTP ${response.status}`);
      const parsedDetails =
        parsedRecord && typeof parsedRecord.details === "string" ? parsedRecord.details.trim() : "";
      const details = parsedDetails ? `: ${parsedDetails}` : "";
      this.logSignerHttp(
        op,
        method,
        tracePath,
        response.status,
        Date.now() - startedAtMs,
        traceContext,
        `${message}${details}`,
      );
      throw new Error(`${op} http_${response.status} message=${message}${details}`);
    }
    this.logSignerHttp(
      op,
      method,
      tracePath,
      response.status,
      Date.now() - startedAtMs,
      traceContext,
    );
    return (await response.json()) as T;
  }

  async postSignerJson<T>(op: string, path: string, payload: Record<string, unknown>): Promise<T> {
    return this.fetchSignerJson<T>(op, path, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async getSignerJson<T>(op: string, path: string): Promise<T> {
    return this.fetchSignerJson<T>(op, path, {
      method: "GET",
    });
  }
}
