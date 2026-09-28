import { EXPO_PUSH_SEND_URL, EXPO_PUSH_MAX_PER_REQUEST } from "../../config/constants";
import type { DevDevice, NotificationPayload } from "./notificationTypes";

// Sends through Expo's push service, which fans out to APNs and FCM. Unlike a
// production sender this runs in the app: the endpoint needs no credentials, so
// a device can push to another device. That is exactly what makes it useful for
// dev testing and exactly why it must never become the production path — a real
// sender belongs in a backend that owns the recipient list.

export type ExpoPushResult = {
  token: string;
  ok: boolean;
  detail: string;
};

type ExpoPushTicket = {
  status?: string;
  message?: string;
  details?: { error?: string };
};

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function describeTicket(ticket: ExpoPushTicket | undefined): { ok: boolean; detail: string } {
  if (!ticket) return { ok: false, detail: "no ticket returned" };
  if (ticket.status === "ok") return { ok: true, detail: "queued" };
  const error = ticket.details?.error;
  return {
    ok: false,
    detail: error ? `${ticket.message ?? "error"} (${error})` : (ticket.message ?? "error"),
  };
}

/**
 * Queues one notification per Expo token. Resolving only means Expo accepted the
 * message — actual delivery is reported later via push receipts, which a backend
 * would poll. Web-push subscriptions are rejected: reaching those needs the VAPID
 * private key, which no client may hold.
 */
export async function sendExpoPush(
  devices: DevDevice[],
  payload: NotificationPayload,
): Promise<ExpoPushResult[]> {
  const results: ExpoPushResult[] = [];
  const expoDevices: DevDevice[] = [];

  for (const device of devices) {
    if (device.kind === "expo") {
      expoDevices.push(device);
      continue;
    }
    results.push({
      token: device.token,
      ok: false,
      detail: "web push needs a server holding the VAPID private key",
    });
  }

  for (const batch of chunk(expoDevices, EXPO_PUSH_MAX_PER_REQUEST)) {
    const messages = batch.map((device) => ({
      to: device.token,
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
      sound: "default",
    }));

    try {
      const response = await fetch(EXPO_PUSH_SEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(messages),
      });
      const json: unknown = await response.json().catch((): null => null);
      const data = (json as { data?: unknown } | null)?.data;
      const tickets: ExpoPushTicket[] = Array.isArray(data) ? (data as ExpoPushTicket[]) : [];
      batch.forEach((device, index) => {
        const { ok, detail } = describeTicket(tickets[index]);
        results.push({ token: device.token, ok, detail });
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      for (const device of batch) results.push({ token: device.token, ok: false, detail });
    }
  }

  return results;
}
