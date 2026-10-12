// eSIM purchases from nadanada.me, paid over Lightning: the pure half (types,
// response parsing, record merging, pending-order lifecycle). No React Native,
// no network, no storage, so it is testable as-is (services/esim/EsimService
// does the I/O).

/**
 * Nuri's nadanada referral code, sent on every purchase and top-up. Its
 * commission is paid out to our BTC fee collector.
 */
export const NADANADA_REF_CODE = "nuri-store";

/**
 * How long an order nobody is known to have paid is kept after its invoice
 * expired. The order is the only handle on the eSIM it bought, so it outlives
 * the invoice by a wide margin; an order the wallet itself paid is never
 * dropped (see `canDropPending`).
 */
export const PENDING_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** nadanada's no-login page for one eSIM: install details, data, top-ups. */
export function esimDashboardUrl(iccid: string): string {
  return `https://nadanada.me/user/${encodeURIComponent(iccid)}`;
}

export type EsimPlace = {
  kind: "country" | "region";
  /** ISO alpha-2 for a country, the region slug for a region. */
  code: string;
  name: string;
  /** Country/region slug nadanada prices a purchase by. */
  slug: string;
  /** Emoji flag for a country, nadanada's own symbol for a region. */
  flag: string;
};

// nadanada's website draws each region with its own symbol, but the
// /esim/countries API omits it; same symbols, keyed by slug. A `symbol` field
// from the API wins once it sends one.
const REGION_SYMBOLS: Record<string, string> = {
  africa: "🐘",
  asia: "🥢",
  balkans: "🎻",
  caribbean: "🏝",
  "central-america": "🌴",
  "central-asia": "⛰️",
  europe: "🏰",
  global: "🌍",
  latam: "⚽",
  "middle-east": "🕋",
  "north-america": "🌽",
  oceania: "🦘",
  "south-east-asia": "🛕",
};

export type EsimPlan = {
  name: string;
  dataGb: number | null;
  days: number | null;
  unlimited: boolean;
  /** Catalog price in USD (before nadanada's Lightning discount). */
  priceUsd: number;
};

export type EsimInstall = {
  qrCode?: string;
  manualCode?: string;
  smdpAddress?: string;
  matchingId?: string;
  appleInstallUrl?: string;
  androidInstallUrl?: string;
};

/** An order whose invoice exists; the eSIM is fetched once it settles. */
export type EsimPendingOrder = {
  paymentHash: string;
  checkoutId: string;
  invoice: string;
  bundleName: string;
  placeName: string;
  priceUsd: number;
  createdAt: number;
  /** Invoice expiry, epoch ms. */
  expiresAt: number;
  /** Set once this wallet's own Lightning send for the invoice is funded. */
  paidAt?: number;
  /**
   * Set (and backed up to the relays) immediately before this wallet funds a
   * Lightning send for the invoice. Lives in the order itself, so it survives
   * a wallet restore: the invoice is then never offered for payment again.
   */
  sendStartedAt?: number;
  /** A top-up: the owned eSIM (ICCID) this order adds a bundle to. */
  topupIccid?: string;
  /** Country/region slug, so a top-up can be priced for the same place. */
  placeSlug?: string;
};

export type OwnedEsim = {
  iccid: string;
  bundleName: string;
  placeName: string;
  priceUsd: number;
  purchasedAt: number;
  paymentHash: string;
  install: EsimInstall;
  /** nadanada's own handles, for support. */
  checkoutId?: string;
  orderReference?: string;
  placeSlug?: string;
};

export type EsimRecord = {
  version: 1;
  esims: OwnedEsim[];
  pending: EsimPendingOrder[];
  /** Payment hashes of delivered top-ups, so no older copy revives them. */
  doneTopups: string[];
};

export const emptyEsimRecord = (): EsimRecord => ({
  version: 1,
  esims: [],
  pending: [],
  doneTopups: [],
});

export type CreatedOrder = {
  /** What nadanada says this order is for, echoed back to bind the invoice. */
  bundleName: string;
  slug: string;
  checkoutId: string;
  paymentHash: string;
  invoice: string;
  priceUsd: number;
  expiresAt: number | null;
};

export type TopupCompleteResult = { status: "unpaid" } | { status: "done" };

/** /esim/{iccid}/complete: 402 = not settled yet; 200 = bundle added. */
export function parseTopupComplete(status: number, body: unknown): TopupCompleteResult {
  if (status === 402) return { status: "unpaid" };
  unwrap(body, "top-up");
  return { status: "done" };
}

export type CompleteResult =
  | { status: "unpaid" }
  | {
      status: "done";
      iccid: string;
      bundleName: string;
      orderReference?: string;
      install: EsimInstall;
    };

const HASH_RE = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** The /esim/purchase body: Lightning, with Nuri's referral code. */
export function purchaseRequestBody(place: EsimPlace, plan: EsimPlan) {
  return {
    bundleName: plan.name,
    slug: place.slug,
    paymentMethod: "lightning" as const,
    refCode: NADANADA_REF_CODE,
  };
}

/** `{success, data}` envelope → data, or throw the merchant's own message. */
export function unwrap(body: unknown, what: string): Record<string, unknown> {
  if (!isRecord(body)) throw new Error(`nadanada ${what}: invalid response`);
  if (body.success === false || (!("data" in body) && typeof body.error === "string")) {
    throw new Error(text(body.error) ?? text(body.message) ?? `nadanada ${what} failed`);
  }
  const data = body.data;
  if (!isRecord(data)) throw new Error(`nadanada ${what}: invalid response`);
  return data;
}

export function parsePlaces(body: unknown): EsimPlace[] {
  const data = unwrap(body, "countries");
  const countries = (Array.isArray(data.countries) ? data.countries : [])
    .filter(isRecord)
    .map((c): EsimPlace | null => {
      const code = text(c.code);
      const name = text(c.name);
      const slug = text(c.slug);
      return code && name && slug
        ? { kind: "country", code: code.toUpperCase(), name, slug, flag: text(c.flag) ?? "" }
        : null;
    });
  const regions = (Array.isArray(data.regions) ? data.regions : [])
    .filter(isRecord)
    .map((r): EsimPlace | null => {
      const name = text(r.name);
      const slug = text(r.slug);
      return name && slug
        ? {
            kind: "region",
            code: slug,
            name,
            slug,
            flag: text(r.symbol) ?? REGION_SYMBOLS[slug] ?? "",
          }
        : null;
    });
  const byName = (a: EsimPlace, b: EsimPlace) => a.name.localeCompare(b.name);
  return [
    ...regions.filter((p): p is EsimPlace => p !== null).sort(byName),
    ...countries.filter((p): p is EsimPlace => p !== null).sort(byName),
  ];
}

export function parsePlans(body: unknown): EsimPlan[] {
  const data = unwrap(body, "bundles");
  return (Array.isArray(data.bundles) ? data.bundles : [])
    .filter(isRecord)
    .map((b): EsimPlan | null => {
      const name = text(b.name);
      const priceUsd = num(b.price);
      if (!name || priceUsd === null || priceUsd <= 0) return null;
      return {
        name,
        dataGb: num(b.dataInGB),
        days: num(b.durationInDays),
        unlimited: b.unlimited === true,
        priceUsd,
      };
    })
    .filter((p): p is EsimPlan => p !== null)
    .sort((a, b) => a.priceUsd - b.priceUsd);
}

export function parseCreatedOrder(body: unknown): CreatedOrder {
  const data = unwrap(body, "purchase");
  const checkoutId = text(data.checkoutId);
  const paymentHash = text(data.paymentHash)?.toLowerCase();
  const invoice = text(data.paymentRequest);
  const priceUsd = num(data.price);
  const bundleName = text(data.bundleName);
  const slug = text(data.slug);
  if (
    !checkoutId ||
    !paymentHash ||
    !HASH_RE.test(paymentHash) ||
    !invoice ||
    priceUsd === null ||
    !bundleName ||
    !slug
  ) {
    throw new Error("nadanada did not return a Lightning invoice");
  }
  const expiresAtMs = text(data.expiresAt) ? Date.parse(String(data.expiresAt)) : Number.NaN;
  return {
    bundleName,
    slug,
    checkoutId,
    paymentHash,
    invoice,
    priceUsd,
    expiresAt: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
  };
}

/**
 * The invoice is what the wallet pays, and the payment hash is what the eSIM
 * is later claimed with. A response whose invoice commits to a different hash
 * (or no amount) would take the money and leave nothing to claim with.
 */
export function assertInvoiceMatchesOrder(
  order: CreatedOrder,
  invoice: { paymentHash: string; amountSats: number },
  requested: { bundleName: string; slug: string },
): void {
  // The order must be for exactly what the user picked: paying an invoice for
  // another bundle or place would provision something other than what is shown.
  if (order.bundleName !== requested.bundleName || order.slug !== requested.slug) {
    throw new Error("nadanada returned an order for a different plan");
  }
  if (invoice.paymentHash.toLowerCase() !== order.paymentHash) {
    throw new Error("nadanada invoice does not match its order");
  }
  if (!Number.isFinite(invoice.amountSats) || invoice.amountSats <= 0) {
    throw new Error("nadanada invoice has no amount");
  }
}

/**
 * /esim/complete: 402 = not settled yet; 404 = nadanada has no checkout for
 * this payment, so nothing was paid to it either; 200 = the eSIM.
 */
export function parseComplete(status: number, body: unknown): CompleteResult {
  if (status === 402 || status === 404) return { status: "unpaid" };
  const data = unwrap(body, "complete");
  const nested = isRecord(data.esimData) ? data.esimData : {};
  const install = isRecord(data.installationDetails) ? data.installationDetails : nested;
  const iccid = text(data.iccid) ?? text(nested.iccid);
  const bundleName = text(data.bundleName) ?? "";
  if (!iccid) throw new Error("nadanada did not return the eSIM");
  const details: EsimInstall = {
    qrCode: text(install.qrCode),
    manualCode: text(install.manualCode),
    smdpAddress: text(install.smdpAddress),
    matchingId: text(install.matchingId),
    appleInstallUrl: text(install.appleInstallUrl),
    androidInstallUrl: text(install.androidInstallUrl),
  };
  // Completing removes the pending order, so a delivery the user cannot
  // install from is not a delivery: stay pending and ask again (complete is
  // idempotent on nadanada's side).
  if (!activationCode(details) && !details.appleInstallUrl && !details.androidInstallUrl) {
    throw new Error("nadanada returned the eSIM without install details");
  }
  return {
    status: "done",
    iccid,
    bundleName,
    orderReference: text(data.orderReference),
    install: details,
  };
}

/** The activation code an eSIM QR carries: the manual code, else LPA:1$smdp$id. */
export function activationCode(install: EsimInstall): string | null {
  if (install.manualCode) return install.manualCode;
  if (install.smdpAddress && install.matchingId) {
    return `LPA:1$${install.smdpAddress}$${install.matchingId}`;
  }
  if (install.qrCode?.startsWith("LPA:")) return install.qrCode;
  return null;
}

export type EsimBundleState = "current" | "next" | "expired";

export type EsimBundle = {
  name: string;
  /** "1 GB · 7 days · Colombia" style, from nadanada's description. */
  description: string;
  state: EsimBundleState;
  usedBytes: number;
  totalBytes: number;
  unlimited: boolean;
  /** Epoch ms; null until the bundle starts (first use in its country). */
  startsAt: number | null;
  endsAt: number | null;
};

export type EsimStatus = {
  installed: boolean;
  firstInstalledAt: number | null;
  bundles: EsimBundle[];
};

function bundleState(raw: string | undefined, active: boolean): EsimBundleState {
  const state = (raw ?? "").toLowerCase();
  if (active || state === "active") return "current";
  // Seen live: "depleted" (data used up) and "expired" (time ran out). Anything
  // else (queued, not started) is still to come.
  if (/^(depleted|expired|ended|finished|completed|cancel)/.test(state)) return "expired";
  return "next";
}

/**
 * GET /esim/{iccid}: install state and every bundle with its own usage. One
 * entry per assignment (a bundle bought twice is two entries). Quantities are
 * nadanada's provider units, which are bytes (1 GB plan = 1e9).
 */
export function parseEsimStatus(body: unknown): EsimStatus {
  const data = unwrap(body, "status");
  const installedAt =
    num(data.firstInstalledDateTime) ??
    (text(data.firstInstalledAt) ? Date.parse(String(data.firstInstalledAt)) : Number.NaN);
  const status = (text(data.profileStatus) ?? "").toLowerCase();
  const bundles: EsimBundle[] = [];
  for (const b of (Array.isArray(data.bundles) ? data.bundles : []).filter(isRecord)) {
    const name = text(b.name) ?? "";
    const description = text(b.description) ?? name;
    const assignments = (Array.isArray(b.assignments) ? b.assignments : []).filter(isRecord);
    const rows = assignments.length > 0 ? assignments : [b];
    for (const a of rows) {
      const usage = isRecord(a.usage) ? a.usage : a;
      const total = num(a.initialQuantity) ?? num(usage.totalInitialQuantity) ?? 0;
      const used = num(a.usedQuantity) ?? num(usage.totalUsedQuantity) ?? 0;
      const start = text(a.startTime) ? Date.parse(String(a.startTime)) : Number.NaN;
      const end = text(a.endTime) ? Date.parse(String(a.endTime)) : Number.NaN;
      bundles.push({
        name,
        description,
        state: bundleState(text(a.state), assignments.length === 0 && b.active === true),
        usedBytes: Math.max(0, used),
        totalBytes: Math.max(0, total),
        unlimited: a.unlimited === true,
        startsAt: Number.isFinite(start) ? start : null,
        endsAt: Number.isFinite(end) ? end : null,
      });
    }
  }
  bundles.sort(
    (x, y) => (y.startsAt ?? Number.MAX_SAFE_INTEGER) - (x.startsAt ?? Number.MAX_SAFE_INTEGER),
  );
  return {
    installed: Number.isFinite(installedAt) || status === "installed" || status === "enabled",
    firstInstalledAt: Number.isFinite(installedAt) ? installedAt : null,
    bundles,
  };
}

/** Data left across the bundles in use now; null when none is current. */
export function currentDataLeft(status: EsimStatus): number | null {
  const current = status.bundles.filter((b) => b.state === "current" && !b.unlimited);
  if (current.length === 0) return null;
  return current.reduce((sum, b) => sum + Math.max(0, b.totalBytes - b.usedBytes), 0);
}

/** Bytes as nadanada shows them (decimal): "236.11 MB", "1.50 GB". */
export function formatDataAmount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(2)} MB`;
}

/** Whole days left until `endsAt` (0 on the last day), null without an end. */
export function daysLeft(endsAt: number | null, now: number): number | null {
  if (endsAt === null) return null;
  return Math.max(0, Math.floor((endsAt - now) / 86_400_000));
}

export type InstallParts = {
  /** Full LPA string: what the QR carries and GrapheneOS takes as one paste. */
  activation: string;
  smdpAddress: string | null;
  /** The matching id, called "Activation code" in iOS/Android settings. */
  activationCode: string | null;
};

/** The pieces each manual-install path asks for. */
export function installParts(install: EsimInstall): InstallParts | null {
  const full = activationCode(install);
  if (!full) return null;
  const parts = full.startsWith("LPA:") ? full.split("$") : [];
  return {
    activation: full,
    smdpAddress: install.smdpAddress ?? parts[1] ?? null,
    activationCode: install.matchingId ?? parts[2] ?? null,
  };
}

/** Plain label for a plan: "1 GB · 7 days", "Unlimited · 30 days". */
export function planSummary(
  plan: Pick<EsimPlan, "dataGb" | "days" | "unlimited">,
  words: { unlimited: string; days: (n: number) => string },
): string {
  const data = plan.unlimited ? words.unlimited : plan.dataGb !== null ? `${plan.dataGb} GB` : "";
  const days = plan.days !== null ? words.days(plan.days) : "";
  return [data, days].filter(Boolean).join(" · ");
}

/** Places matching a search, the device's own country first when nothing is typed. */
export function filterPlaces(
  places: EsimPlace[],
  query: string,
  homeCountry: string | null,
): EsimPlace[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle) {
    return places.filter(
      (p) => p.name.toLocaleLowerCase().includes(needle) || p.code.toLocaleLowerCase() === needle,
    );
  }
  const home = homeCountry?.toUpperCase();
  const first = places.find((p) => p.kind === "country" && p.code === home);
  return first ? [first, ...places.filter((p) => p !== first)] : places;
}

/** An order to keep tracking: unpaid orders go once expiry plus grace passed. */
export function isPendingLive(order: EsimPendingOrder, now: number): boolean {
  return now < order.expiresAt + PENDING_GRACE_MS;
}

/**
 * Whether an order may be forgotten. Never once the wallet paid it: the order
 * is then the user's only claim on an eSIM, kept until nadanada delivers it.
 */
export function canDropPending(order: EsimPendingOrder, now: number): boolean {
  return (
    order.paidAt === undefined && order.sendStartedAt === undefined && !isPendingLive(order, now)
  );
}

/** Pending orders worth showing: an open invoice, or one the wallet paid. */
export function visiblePending(order: EsimPendingOrder, now: number): boolean {
  return order.paidAt !== undefined || isInvoiceOpen(order, now);
}

/** Whether the invoice can still be paid (shown as "waiting for payment"). */
export function isInvoiceOpen(order: EsimPendingOrder, now: number): boolean {
  return now < order.expiresAt;
}

/**
 * Time an invoice must still have left to be offered for payment again: the
 * send flow quotes, asks for the passkey and refuses to fund in its last
 * minute, so an invoice closer to expiry than this would only fail there.
 */
export const REOPEN_MIN_LEFT_MS = 5 * 60 * 1000;

/**
 * Whether an unpaid order's invoice may be handed to the send sheet again.
 * Only for an order this wallet never started paying (no funded send, no send
 * record for its hash): a second send of an invoice that already has one would
 * lock sats nobody can claim.
 */
export function canReopenPayment(
  order: EsimPendingOrder,
  now: number,
  sendStartedForHash: boolean,
): boolean {
  return (
    order.paidAt === undefined &&
    order.sendStartedAt === undefined &&
    !sendStartedForHash &&
    order.expiresAt - now > REOPEN_MIN_LEFT_MS
  );
}

function isOwned(value: unknown): value is OwnedEsim {
  return (
    isRecord(value) &&
    typeof value.iccid === "string" &&
    value.iccid.length > 0 &&
    typeof value.bundleName === "string" &&
    typeof value.placeName === "string" &&
    typeof value.priceUsd === "number" &&
    typeof value.purchasedAt === "number" &&
    typeof value.paymentHash === "string" &&
    isRecord(value.install)
  );
}

function isPending(value: unknown): value is EsimPendingOrder {
  return (
    isRecord(value) &&
    typeof value.paymentHash === "string" &&
    HASH_RE.test(value.paymentHash) &&
    typeof value.checkoutId === "string" &&
    typeof value.invoice === "string" &&
    typeof value.bundleName === "string" &&
    typeof value.placeName === "string" &&
    typeof value.priceUsd === "number" &&
    typeof value.createdAt === "number" &&
    typeof value.expiresAt === "number" &&
    (value.paidAt === undefined || typeof value.paidAt === "number") &&
    (value.sendStartedAt === undefined || typeof value.sendStartedAt === "number") &&
    (value.topupIccid === undefined || typeof value.topupIccid === "string")
  );
}

/** Parse a stored record; anything unreadable is dropped, never thrown. */
export function parseRecord(raw: string | null | undefined): EsimRecord {
  if (!raw) return emptyEsimRecord();
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return emptyEsimRecord();
    return {
      version: 1,
      esims: Array.isArray(value.esims) ? value.esims.filter(isOwned) : [],
      pending: Array.isArray(value.pending) ? value.pending.filter(isPending) : [],
      doneTopups: Array.isArray(value.doneTopups)
        ? value.doneTopups.filter((h): h is string => typeof h === "string" && HASH_RE.test(h))
        : [],
    };
  } catch {
    return emptyEsimRecord();
  }
}

/**
 * Union of two copies (this device and the relay backup). An eSIM is never
 * dropped; a pending order is dropped once an eSIM carries its payment hash.
 */
export function mergeRecords(a: EsimRecord, b: EsimRecord): EsimRecord {
  const esims = new Map<string, OwnedEsim>();
  for (const esim of [...a.esims, ...b.esims]) {
    if (!esims.has(esim.iccid)) esims.set(esim.iccid, esim);
  }
  const doneTopups = [...new Set([...a.doneTopups, ...b.doneTopups])].sort();
  const claimed = new Set([...[...esims.values()].map((e) => e.paymentHash), ...doneTopups]);
  const pending = new Map<string, EsimPendingOrder>();
  for (const order of [...a.pending, ...b.pending]) {
    if (claimed.has(order.paymentHash)) continue;
    const seen = pending.get(order.paymentHash);
    // Facts only ever get added: a copy that knows the order was paid, or that
    // a send for it started, keeps that. Losing either would let the order be
    // dropped as unpaid or its invoice offered for a second payment.
    const paidAt = seen?.paidAt ?? order.paidAt;
    const sendStartedAt = seen?.sendStartedAt ?? order.sendStartedAt;
    pending.set(order.paymentHash, {
      ...(seen ?? order),
      ...(paidAt !== undefined ? { paidAt } : {}),
      ...(sendStartedAt !== undefined ? { sendStartedAt } : {}),
    });
  }
  return {
    version: 1,
    esims: [...esims.values()].sort((x, y) => y.purchasedAt - x.purchasedAt),
    pending: [...pending.values()].sort((x, y) => y.createdAt - x.createdAt),
    doneTopups,
  };
}

/** Same content, regardless of order (decides whether a backup is needed). */
export function sameRecord(a: EsimRecord, b: EsimRecord): boolean {
  const key = (r: EsimRecord) =>
    JSON.stringify([
      r.esims.map((e) => e.iccid).sort(),
      r.pending.map((p) => `${p.paymentHash}:${p.paidAt ?? ""}:${p.sendStartedAt ?? ""}`).sort(),
      [...r.doneTopups].sort(),
    ]);
  return key(a) === key(b);
}
