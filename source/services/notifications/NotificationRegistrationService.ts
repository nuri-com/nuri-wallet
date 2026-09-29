import AsyncStorage from "@react-native-async-storage/async-storage";
import { NOTIFICATIONS_API_BASE_URL } from "../../config/network";
import { bytesToHex, randomBytes } from "../../lib/crypto";
import { arkadeBindNotificationSubscription } from "../arkade/ArkadeApiService";
import { getArkadeLnurlAssertion } from "../arkade/internal/identity";
import { wirexService } from "../wirex/WirexService";
import { getPermission, getPushToken, requestPermission } from "./NotificationService";
import {
  anyNotificationEnabled,
  type NotificationCategory,
  type NotificationPreferences,
  parseNotificationPreferences,
} from "./notificationPreferences";
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

// Registration and the Settings category switch run one at a time. Without
// this, the fire-and-forget sign-in sync could finish its `/devices` POST and
// rewrite the cache AFTER Settings had turned a category off and retired that
// registration — re-creating a device the user just opted out of. Queued, a
// sync already in flight completes first and the switch then retires it.
let registrationQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = registrationQueue.then(task, task);
  registrationQueue = run.catch((): undefined => undefined);
  return run;
}

// Bumped by every category switch. The binds the silent path starts without
// awaiting outlive the queue slot they were started in; each one re-checks this
// before calling a server, so a bind started under the old choice never lands
// after the switch.
let preferencesGeneration = 0;

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
export function registerPushToken(options?: {
  prompt?: boolean;
}): Promise<PushRegistrationState> {
  return serialized(() => registerPushTokenNow(options));
}

async function registerPushTokenNow(options?: {
  prompt?: boolean;
}): Promise<PushRegistrationState> {
  // No server yet: skip before touching permissions, so nothing prompts the
  // user for a capability that cannot work.
  if (!NOTIFICATIONS_API_BASE_URL) return { kind: "disabled", reason: "no-server" };
  // Every category turned off in Settings: nothing to register for.
  const generation = preferencesGeneration;
  const preferences = await getNotificationPreferences();
  if (!anyNotificationEnabled(preferences)) return { kind: "disabled", reason: "opted-out" };

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
    if (
      !(await bindNamespaces(options?.prompt === true, preferences, subscriptionId, generation))
    ) {
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
    if (
      !(await bindNamespaces(options?.prompt === true, preferences, subscriptionId, generation))
    ) {
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
 *
 * Only the categories the user left on are bound: a namespace that is never
 * bound never pushes to this device.
 */
async function bindNamespaces(
  allowPrompt: boolean,
  preferences: NotificationPreferences,
  subscriptionId: string,
  generation: number,
): Promise<boolean> {
  // Bound to the subscription this registration used, never re-read: a switch
  // that retires it mints a new one, and a late bind must not attach the old
  // choice to that.
  if (preferences.banking) void bindWirex(subscriptionId, generation);
  if (!preferences.bitcoin) return true;
  if (!allowPrompt) {
    void bindArkade(subscriptionId, generation, false);
    return true;
  }
  return bindArkade(subscriptionId, generation, true);
}

/**
 * Which notification categories the user wants (Settings). A device
 * preference, so it survives logout and is not part of
 * `clearPushNotificationStorage`: otherwise the silent sign-in sync would bind
 * a category the user switched off again on the next start.
 */
export const PUSH_CATEGORIES_STORAGE_KEY = "@nuri:push_categories:v1";

export async function getNotificationPreferences(): Promise<NotificationPreferences> {
  try {
    return parseNotificationPreferences(await AsyncStorage.getItem(PUSH_CATEGORIES_STORAGE_KEY));
  } catch {
    return parseNotificationPreferences(null);
  }
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
 * Turns one category on or off.
 *
 * On: bind that namespace (may show the OS permission prompt and, for bitcoin,
 * Face ID — the user just asked for it).
 *
 * Off: the notification server has no per-namespace unbind, so this device's
 * subscription is retired (server unregister → its bindings cascade away) and a
 * fresh one is registered and bound for the categories still on. The choice is
 * stored first, so a failed server call cannot leave the category coming back
 * on the next sign-in.
 */
export function setNotificationCategory(
  category: NotificationCategory,
  enabled: boolean,
): Promise<PushRegistrationState> {
  // Bumped before queueing, so binds already started stand down at once.
  preferencesGeneration += 1;
  return serialized(async () => {
    const next = { ...(await getNotificationPreferences()), [category]: enabled };
    try {
      await AsyncStorage.setItem(PUSH_CATEGORIES_STORAGE_KEY, JSON.stringify(next));
    } catch {}
    if (!enabled) {
      await unregisterPushDevice();
      await clearPushNotificationStorage();
      if (!anyNotificationEnabled(next)) return { kind: "disabled", reason: "opted-out" };
    }
    return registerPushTokenNow({ prompt: true });
  });
}

/** Whether this device is registered with the notification server and allowed to show them. */
export async function isPushDeviceActive(): Promise<boolean> {
  if (!NOTIFICATIONS_API_BASE_URL) return false;
  if ((await getPermission()) !== "granted") return false;
  return (await readCache()) !== null;
}

/**
 * Which categories actually reach this device — what Settings shows as On.
 *
 * Bitcoin needs arkade's binding for the subscription the device is registered
 * under: a registered device without it is one the server has no payment to
 * route to (Face ID cancelled, arkade unreachable). Banking stays best-effort,
 * as its bind is: a registered device is enough, since most accounts have no
 * Wirex session to bind with and that must not read as Off.
 */
export async function getActiveNotificationCategories(): Promise<NotificationPreferences> {
  const [preferences, active, registration, bound] = await Promise.all([
    getNotificationPreferences(),
    isPushDeviceActive(),
    readCache(),
    readBindingCache(),
  ]);
  return {
    bitcoin:
      active &&
      preferences.bitcoin &&
      registration !== null &&
      bound === registration.subscriptionId,
    banking: active && preferences.banking,
  };
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
  return bindArkade(
    await getSubscriptionId(),
    preferencesGeneration,
    options?.allowPrompt === true,
  );
}

async function bindArkade(
  subscriptionId: string,
  generation: number,
  allowPrompt: boolean,
): Promise<boolean> {
  if ((await readBindingCache()) === subscriptionId) return true;
  try {
    const assertion = await getArkadeLnurlAssertion("push_subscription_bind", allowPrompt);
    // The Face ID prompt can sit open for a while: re-check right before the
    // server call, so a category switched meanwhile wins.
    if (!assertion || generation !== preferencesGeneration) return false;
    await arkadeBindNotificationSubscription(assertion, subscriptionId);
    if (generation !== preferencesGeneration) return false;
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
  const registration = await readCache();
  if (!registration) return false;
  return bindWirex(registration.subscriptionId, preferencesGeneration);
}

async function bindWirex(subscriptionId: string, generation: number): Promise<boolean> {
  try {
    if (generation !== preferencesGeneration) return false;
    return await wirexService.bindNotificationSubscription(subscriptionId);
  } catch {
    return false;
  }
}
