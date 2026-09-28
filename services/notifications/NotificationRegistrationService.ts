import AsyncStorage from "@react-native-async-storage/async-storage";
import { NOTIFICATIONS_API_BASE_URL } from "../../config/network";
import { bytesToHex, randomBytes } from "../../lib/crypto";
import { arkadeBindNotificationSubscription } from "../arkade/ArkadeApiService";
import { getArkadeLnurlAssertion } from "../arkade/internal/identity";
import { wirexService } from "../wirex/WirexService";
import { getPermission, getPushToken, requestPermission } from "./NotificationService";
import type { PushRegistrationState } from "./notificationTypes";

// Tells the notification server which devices to push to, and which payments to
// watch on their behalf. The server owns the token registry and the sending.
//
// Deliberately NOT keyed on any wallet identity (credId, EOA, …). A claimed
// identity has to be proven, and proving one would need a trusted credId→pubkey
// source that only the arkade server holds — plus, for a signature, an unlocked
// key. Instead the client mints a random subscription id: a bearer secret with
// nothing to impersonate. Registering under someone else's subscription means
// guessing 128 bits, so `/devices` needs no authentication at all.
//
// Arkade vouches for the link: it verifies the passkey assertion it already
// handles and forwards the binding. That has to be a standing binding, not a
// per-payment one — a payment to a static Lightning address is invoiced by
// arkade itself, with this device never involved.
//
// One install needs TWO such vouches, one per rail, against the SAME
// subscription id: `arkade`/passkey credId for Lightning, and `wirex`/owner EOA
// for card spend, SEPA movements, card limits and 3DS. The server keys bindings
// on (namespace, external_id, subscription_id), so neither displaces the other
// and both resolve to this device's token — and orphaning the one subscription
// on a factory reset cascades both away.
//
// Token rotation is covered without a listener here: `syncPushRegistration()`
// runs on sign-in and from the token-change listener, and the cache comparison
// re-POSTs whenever the token or the subscription id changed.

export const PUSH_REGISTRATION_STORAGE_KEY = "@nuri:push_registration:v1";
export const PUSH_SUBSCRIPTION_ID_STORAGE_KEY = "@nuri:push_subscription_id:v1";
export const PUSH_BINDING_STORAGE_KEY = "@nuri:push_binding:v1";

const REGISTER_TIMEOUT_MS = 8_000;
const SUBSCRIPTION_ID_BYTES = 16;

type CachedRegistration = { token: string; subscriptionId: string };

/**
 * This install's subscription id, minted on first use. It is a secret: anyone
 * holding it can attach a device and receive this wallet's notifications, so it
 * must never be logged or shared. The reset paths drop it via
 * `clearPushNotificationStorage`, which orphans the old one server-side.
 */
export async function getSubscriptionId(): Promise<string> {
  try {
    const existing = await AsyncStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY);
    if (existing && existing.trim()) return existing.trim();
  } catch {}
  const minted = bytesToHex(randomBytes(SUBSCRIPTION_ID_BYTES));
  try {
    await AsyncStorage.setItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY, minted);
  } catch {}
  return minted;
}

/**
 * Tells the server to forget this device, then drops the local state.
 *
 * Clearing locally is not enough on its own. The push token survives a wallet
 * wipe — it belongs to the install — so the server would keep the old wallet's
 * subscription pointing at a token that still works, and this device would go
 * on receiving that wallet's payment notifications. The re-registration under
 * the next wallet only repairs this if it ever happens; a user who does not
 * turn notifications back on would stay subscribed to the previous wallet
 * indefinitely.
 *
 * Best-effort by design: a reset must complete even with no network. The local
 * state is cleared either way, and the server-side row is additionally covered
 * by its own pruning once the token stops accepting pushes.
 *
 * Must run BEFORE the keychain wipe — the request is identified by the current
 * subscription, and later steps tear that context down.
 *
 * The result is for the debug tools; the reset paths ignore it on purpose.
 */
export async function unregisterPushDevice(): Promise<{ ok: boolean; detail: string }> {
  if (!NOTIFICATIONS_API_BASE_URL) return { ok: false, detail: "no server configured" };
  try {
    const cached = await readCache();
    if (!cached) return { ok: false, detail: "device was never registered" };
    const response = await postJson("/devices/unregister", {
      subscriptionId: cached.subscriptionId,
      token: cached.token,
    });
    // 204 covers both a deleted row and a token the server does not know, so a
    // 2xx says the server is done with this device either way.
    return response.ok
      ? { ok: true, detail: `unregistered (HTTP ${response.status})` }
      : { ok: false, detail: `HTTP ${response.status}` };
  } catch (error: unknown) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Drops the subscription, the device registration and the binding cache.
 *
 * Must be called explicitly by the reset paths: `WIPE_EXTRA_STORAGE_KEYS` goes
 * to `wipeAllKeychainData`, which only resets Keychain entries and leaves
 * AsyncStorage untouched. Skipping it lets the next wallet inherit the previous
 * subscription — so this device keeps receiving the old wallet's payment
 * notifications, and the caches suppress both the re-register and the re-bind
 * that would have fixed it.
 */
export async function clearPushNotificationStorage(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([
      PUSH_SUBSCRIPTION_ID_STORAGE_KEY,
      PUSH_REGISTRATION_STORAGE_KEY,
      PUSH_BINDING_STORAGE_KEY,
    ]);
  } catch {}
}

async function readCache(): Promise<CachedRegistration | null> {
  try {
    const raw = await AsyncStorage.getItem(PUSH_REGISTRATION_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return null;
    const entry = parsed as Record<string, unknown>;
    if (typeof entry.token !== "string" || typeof entry.subscriptionId !== "string") return null;
    return { token: entry.token, subscriptionId: entry.subscriptionId };
  } catch {
    return null;
  }
}

async function writeCache(entry: CachedRegistration): Promise<void> {
  try {
    await AsyncStorage.setItem(PUSH_REGISTRATION_STORAGE_KEY, JSON.stringify(entry));
  } catch {}
}

/** Which subscription arkade has already vouched for, so a bind runs once. */
async function readBindingCache(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(PUSH_BINDING_STORAGE_KEY);
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

async function writeBindingCache(subscriptionId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(PUSH_BINDING_STORAGE_KEY, subscriptionId);
  } catch {}
}

async function postJson(path: string, body: Record<string, unknown>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTER_TIMEOUT_MS);
  try {
    return await fetch(`${NOTIFICATIONS_API_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reports this device to the notification server.
 *
 * `prompt: false` never shows the OS permission dialog — it only acts on a
 * permission the user already granted, which makes it safe to call on every
 * sign-in. `prompt: true` is the deliberate opt-in and belongs at a moment
 * where being notified is obviously the point (e.g. creating a Lightning
 * invoice), and must run before any await so the web permission prompt keeps
 * the user activation.
 */
export async function registerPushToken(options?: {
  prompt?: boolean;
}): Promise<PushRegistrationState> {
  // No server yet: skip before touching permissions, so nothing prompts the
  // user for a capability that cannot work.
  if (!NOTIFICATIONS_API_BASE_URL) return { kind: "disabled", reason: "no-server" };

  let permission = await getPermission();
  if (permission === "undetermined" && options?.prompt) {
    permission = await requestPermission();
  }
  if (permission !== "granted") return { kind: "disabled", reason: "permission" };

  const token = await getPushToken();
  if (!token) return { kind: "disabled", reason: "no-token" };

  const subscriptionId = await getSubscriptionId();

  const cached = await readCache();
  if (cached && cached.token === token.value && cached.subscriptionId === subscriptionId) {
    // Still attempt the bindings: they have their own caching, and one that
    // failed earlier (no cached assertion yet, arkade unreachable, no Wirex
    // session) would otherwise never be retried once the device registration
    // itself is cached.
    if (!(await bindNamespaces(options?.prompt === true))) {
      return { kind: "disabled", reason: "not-bound" };
    }
    return { kind: "registered", token: token.value, subscriptionId };
  }

  try {
    const response = await postJson("/devices", {
      subscriptionId,
      token: token.value,
      kind: token.kind,
      platform: token.platform,
    });
    if (!response.ok) {
      return { kind: "error", message: `register failed: HTTP ${response.status}` };
    }
    await writeCache({ token: token.value, subscriptionId });
    if (!(await bindNamespaces(options?.prompt === true))) {
      return { kind: "disabled", reason: "not-bound" };
    }
    return { kind: "registered", token: token.value, subscriptionId };
  } catch (error: unknown) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Vouches for this subscription on both rails and answers "can the server reach
 * us?" for the caller.
 *
 * Only arkade decides that answer. The device is reachable, but without its
 * binding the server has no reason to reach it — and on the opt-in path that
 * distinction is the whole answer to "did notifications turn on?", so it is
 * awaited and a cancelled Face ID or a server failure is reported instead of
 * claimed success. The silent sync does not wait: it must not block sign-in,
 * and it retries next time.
 *
 * The wirex bind never participates in that answer. It is a no-op for every
 * account without a card — most of them — and turning that into "notifications
 * are off" would break Lightning notifications for those users.
 */
async function bindNamespaces(allowPrompt: boolean): Promise<boolean> {
  void bindSubscriptionWithWirex();
  if (!allowPrompt) {
    void bindSubscriptionWithArkade({ allowPrompt: false });
    return true;
  }
  return bindSubscriptionWithArkade({ allowPrompt: true });
}

/** Safe on every sign-in: reports the device only if permission already exists. */
export function syncPushRegistration(): Promise<PushRegistrationState> {
  return registerPushToken({ prompt: false });
}

/** The opt-in path — may show the OS permission dialog. */
export function enablePushNotifications(): Promise<PushRegistrationState> {
  return registerPushToken({ prompt: true });
}

/**
 * Has arkade vouch that this wallet owns the subscription, so a payment can be
 * routed back to this device. Arkade authenticates the passkey assertion and
 * forwards the binding; the notification server never sees a wallet identity.
 *
 * Prompting is tied to the caller: the opt-in path may raise Face ID, since the
 * user just asked for notifications. The silent sign-in path passes
 * `allowPrompt: false` and settles for a cached assertion, so app start never
 * produces a dialog — with none cached it does nothing and the next opt-in or
 * sign-in retries.
 *
 * A standing binding is what covers the case the app cannot see at all: a
 * payment to the static Lightning address, where arkade creates the invoice and
 * this device is never involved.
 */
export async function bindSubscriptionWithArkade(options?: {
  allowPrompt?: boolean;
}): Promise<boolean> {
  const cached = await readBindingCache();
  const subscriptionId = await getSubscriptionId();
  if (cached === subscriptionId) return true;
  try {
    const assertion = await getArkadeLnurlAssertion(
      "push_subscription_bind",
      options?.allowPrompt === true,
    );
    if (!assertion) return false;
    await arkadeBindNotificationSubscription(assertion, subscriptionId);
    await writeBindingCache(subscriptionId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Has the wirex backend vouch that this account owns the subscription, so card
 * spend, SEPA movements, card-limit and 3DS pushes route back to this device.
 *
 * Binds the subscription the device is actually REGISTERED under, not just the
 * minted one: without a device attached there is nothing for the server to push
 * to, and binding then would only create a row for a subscription that no token
 * answers.
 *
 * Deliberately not cached locally, unlike the arkade bind. That one is cached
 * because it costs a passkey assertion; this one is a plain POST once a session
 * exists, and a cache would only add a way to keep a stale binding alive across
 * a wallet change. Re-sending is free — the server inserts on conflict do
 * nothing — and it is the only thing that repairs a binding the server cascaded
 * away after a token change.
 *
 * Never prompts: it uses a Wirex read session only if one is already cached
 * (see `bindNotificationSubscription`), so app start raises no dialog.
 */
export async function bindSubscriptionWithWirex(): Promise<boolean> {
  try {
    const registration = await readCache();
    if (!registration) return false;
    return await wirexService.bindNotificationSubscription(registration.subscriptionId);
  } catch {
    return false;
  }
}
