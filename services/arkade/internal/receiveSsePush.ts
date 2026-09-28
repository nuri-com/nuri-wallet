// Web-only: subscribe to the arkade server's SSE push for incoming Lightning so
// a received payment surfaces instantly instead of waiting up to one poll cycle.
// On an "incoming" event we run the SAME refresh the foreground poll runs, so
// the Payment-Received flow is unchanged — only faster. Native has no
// EventSource (and would need a new dep), so it keeps the existing poll; this is
// the intended web-first / native-follows-with-fallback split.
import { Platform } from "react-native";
import { rewriteUrl } from "../../../lib/web/apiProxy";
import { arkadeServerConfigService } from "../ArkadeServerConfigService";
import { getArkadeReceiveOwner } from "./identity";
import { logArkadeWalletSignTrace } from "./logging";

// Minimal EventSource shape — avoids depending on the DOM lib in a RN tsconfig.
type WebEventSource = {
  close(): void;
  onerror: ((ev: unknown) => void) | null;
  addEventListener(type: string, cb: (ev: { data?: string }) => void): void;
};
type EventSourceCtor = new (url: string) => WebEventSource;

let source: WebEventSource | null = null;
// Synchronous guard: start is async (awaits the owner lookup), and wallet-ready
// can fire several times on load. Without this, concurrent calls all race past
// the `source` check before any EventSource is assigned and open duplicate
// streams (observed as connect churn server-side). Set before the await.
let connecting = false;

export function stopArkadeReceiveSsePush(reason: string): void {
  connecting = false;
  if (!source) return;
  try {
    source.close();
  } catch {}
  source = null;
  logArkadeWalletSignTrace("receive_sse_push", { status: "stopped", reason });
}

export async function startArkadeReceiveSsePush(
  onIncoming: (swapId: string) => void,
): Promise<void> {
  if (Platform.OS !== "web") return;
  if (source || connecting) return; // already connected or mid-connect
  const Ctor = (globalThis as { EventSource?: EventSourceCtor }).EventSource;
  if (!Ctor) return;

  connecting = true;
  let owner: { credIdB64u: string; clientPublicKey33Hex: string };
  try {
    owner = await getArkadeReceiveOwner();
  } catch {
    connecting = false;
    return;
  }
  if (!owner?.credIdB64u || !owner?.clientPublicKey33Hex) {
    connecting = false;
    return;
  }

  const origin = new URL(arkadeServerConfigService.getSignerServerUrl()).origin;
  const absolute =
    `${origin}/api/arkade/receive/subscribe` +
    `?cred_id_b64u=${encodeURIComponent(owner.credIdB64u)}` +
    `&client_public_key_33_hex=${encodeURIComponent(owner.clientPublicKey33Hex)}`;
  // EventSource isn't covered by the fetch/XHR proxy, so map to same-origin here.
  const url = rewriteUrl(absolute);

  try {
    const es = new Ctor(url);
    source = es;
    es.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(String(ev?.data ?? "{}"));
        if (data?.type === "incoming") {
          onIncoming(String(data.swap_id ?? data.swapId ?? ""));
        }
      } catch {}
    });
    es.onerror = () => {
      // Browser EventSource auto-reconnects on its own; nothing to do but note it.
      logArkadeWalletSignTrace("receive_sse_push", { status: "error_autoreconnect" });
    };
    logArkadeWalletSignTrace("receive_sse_push", {
      status: "started",
      expected_next: "incoming_event_triggers_receive_refresh",
    });
  } catch {
    source = null;
  } finally {
    connecting = false;
  }
}
