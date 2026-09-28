// Web Push service worker for the Nuri PWA. Registered by
// services/notifications/NotificationService.web.ts.
//
// Kept deliberately minimal: it renders pushes and relays them to open clients.
// It does no caching — the app is not offline-capable and a stale-asset cache
// here would silently defeat web deploys.

/* global self, clients */

// Must match NOTIFICATION_WEB_MESSAGE_TAG in config/constants.ts.
const MESSAGE_TAG = "nuri:notification";

// Must match NOTIFICATION_WEB_SW_PING / _PONG in config/constants.ts.
const PING_TYPE = "nuri:sw-ping";
const PONG_TYPE = "nuri:sw-pong";

// Must match NOTIFICATION_WEB_TARGET_QUERY_PARAM / _LINK_ in config/constants.ts.
const TARGET_QUERY_PARAM = "nuriNotificationTarget";
const LINK_QUERY_PARAM = "nuriNotificationLink";

// Answers the page's liveness ping. A registered worker that no longer responds
// still satisfies `navigator.serviceWorker.ready`, so without this the app can
// believe notifications are wired up while nothing can deliver them.
self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== PING_TYPE) return;
  const reply = { type: PONG_TYPE };
  if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
  else if (event.source && typeof event.source.postMessage === "function") {
    event.source.postMessage(reply);
  }
});

self.addEventListener("install", () => {
  // Replace the previous worker immediately; there is no cache to migrate.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function parsePush(event) {
  if (!event.data) return { title: "Nuri", body: "", data: {} };
  try {
    const json = event.data.json();
    return {
      title: String(json.title || "Nuri"),
      body: String(json.body || ""),
      data: json.data || {},
    };
  } catch {
    return { title: "Nuri", body: event.data.text(), data: {} };
  }
}

// Reduces a nuri:// link to scheme plus screen. The raw value comes from the
// server and lands in the launch URL, which hosting, proxies and the browser
// all log — so a query or fragment must never get that far. The app validates
// the screen itself (canonicalInternalLink in lib/internalLinks.ts); this only
// has to guarantee nothing extra travels.
function stripLink(url) {
  if (typeof url !== "string") return null;
  const [scheme, rest] = url.split("://");
  if (!scheme || !rest) return null;
  const screen = rest.split(/[?#/]/)[0];
  return screen ? `${scheme}://${screen}` : null;
}

async function relayToClients(kind, payload) {
  const matched = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of matched) {
    client.postMessage({ tag: MESSAGE_TAG, kind, ...payload });
  }
}

self.addEventListener("push", (event) => {
  const payload = parsePush(event);
  event.waitUntil(
    (async () => {
      // userVisibleOnly is set on subscribe, so a push MUST show a notification
      // or the browser revokes the subscription.
      await self.registration.showNotification(payload.title, {
        body: payload.body,
        data: payload.data,
      });
      await relayToClients("received", payload);
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  notification.close();
  const payload = {
    title: notification.title || "",
    body: notification.body || "",
    data: notification.data || {},
  };
  event.waitUntil(
    (async () => {
      const matched = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = matched[0];
      if (existing) {
        // A live client can be messaged directly.
        await existing.focus();
        await relayToClients("tapped", payload);
        return;
      }
      if (!self.clients.openWindow) return;
      // No window open: postMessage would race the new client's mount and
      // usually lose. Carry the destination in the URL instead — the app reads
      // it from `location.search` at startup (NotificationService.web.ts).
      // `url` takes precedence: it can name any screen the deep-link router
      // reaches, while `target` only names a tab.
      // Carry BOTH values. stripLink only sanitises syntax — it cannot know
      // which screens this build routes — so dropping the target here would
      // discard a valid fallback whenever the link names a screen the app
      // rejects. Native and already-open clients keep the whole payload and
      // fall back; the cold start must behave the same. The app decides:
      // link first, target if the link does not validate.
      const data = payload.data || {};
      const params = [];
      const link = stripLink(data.url);
      if (link) params.push(`${LINK_QUERY_PARAM}=${encodeURIComponent(link)}`);
      if (data.target) params.push(`${TARGET_QUERY_PARAM}=${encodeURIComponent(data.target)}`);
      await self.clients.openWindow(params.length ? `/?${params.join("&")}` : "/");
    })(),
  );
});
