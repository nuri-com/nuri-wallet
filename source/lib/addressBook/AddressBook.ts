// Address book sync engine of the app. The desktop tools do not run it: they
// get the book through a passkey approval on connect.nuri.com, which applies
// the same newest-per-slot and relay-ack rules there.
//
// Local state holds ONLY signed, encrypted events (the same bytes the relays
// get), so nothing readable is at rest; contacts are decrypted in memory.
//
// Writes: seal -> keep as pending -> publish to every relay. A write counts as
// synced once at least one relay acked it; until then it stays pending and is
// retried on every sync (durable across restarts).
//
// Sync: publish pending, fetch every event of the collection from every relay,
// pick the newest per contact slot (created_at, then higher id), and republish
// that winner to each relay that answered completely but lacks it (self-heal).
//
// Conflicts: an unsynced local edit whose base version is older than what a
// relay now holds is NOT overwritten or published. It is reported, and the
// user keeps one side with resolveConflict().
//
// Limits: a device can only know what the relays it reached returned; a fresh
// device cannot prove it saw the newest version everywhere. Old ciphertext may
// persist on relays after an edit or delete (relays keep what they choose).
import { zeroize } from "../crypto";
import {
  buildContact,
  type Contact,
  type ContactInput,
  ContactValidationError,
  contactMatches,
  MAX_CONTACTS,
  tombstone,
} from "./contact";
import {
  ADDRESS_BOOK_KIND,
  type AddressBookKeys,
  contactSlot,
  newContactId,
  type OpenedContact,
  openContact,
  sealContact,
} from "./crypto";
import type { NostrEvent } from "../nostr/event";

const FETCH_PAGE_SIZE = 500;

export type RelayFetchResult = { relay: string; events: NostrEvent[]; complete: boolean };

export interface AddressBookTransport {
  relays: string[];
  publish(relay: string, event: NostrEvent): Promise<boolean>;
  fetch(
    relay: string,
    filter: { kinds: number[]; authors: string[]; "#t": string[]; limit: number; until?: number },
  ): Promise<{ events: NostrEvent[]; complete: boolean }>;
}

export interface AddressBookStorage {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
}

type PersistedState = {
  version: 1;
  /** slot -> newest known signed event (local edit or synced remote). */
  events: Record<string, NostrEvent>;
  /** Slots whose event no relay has acked yet. */
  pending: string[];
  /** slot -> created_at of the synced version a pending edit was made on (0 = new). */
  base: Record<string, number>;
  /** slot -> the remote event that conflicts with a pending local edit. */
  conflicts: Record<string, NostrEvent>;
};

export type ContactConflict = { id: string; local: Contact; remote: Contact };

export type SyncReport = {
  published: number;
  publishFailed: number;
  received: number;
  updated: number;
  healed: number;
  conflicts: ContactConflict[];
  relays: Array<{ relay: string; complete: boolean; events: number }>;
};

const emptyState = (): PersistedState => ({
  version: 1,
  events: {},
  pending: [],
  base: {},
  conflicts: {},
});

// NIP-01 addressable events: newest created_at wins; on a tie the LOWEST id
// wins, so clients agree with compliant relays about which one is kept.
const newer = (a: NostrEvent, b: NostrEvent | undefined): boolean =>
  !b ||
  a.created_at > b.created_at ||
  (a.created_at === b.created_at && String(a.id) < String(b.id));

export class AddressBook {
  private state: PersistedState = emptyState();
  private loaded = false;
  private loading: Promise<void> | null = null;
  private closed = false;
  // Decrypted live contacts, rebuilt only after the state changes; read
  // without waiting on the queue, so a screen never waits behind a sync.
  private contactsCache: Contact[] | null = null;
  // Relay sync runs in its own lane, beside the state queue: network I/O never
  // sits in front of an edit. Only its short state steps enter the queue.
  private syncing: Promise<SyncReport> | null = null;
  private syncAgain = false;
  private readonly listeners = new Set<(contacts: Contact[]) => void>();
  private queue: Promise<unknown> = Promise.resolve();

  // Plain fields (no parameter properties) so Node's type stripping can run
  // this module directly.
  private readonly keys: AddressBookKeys;
  private readonly transport: AddressBookTransport;
  private readonly storage: AddressBookStorage;
  private readonly clock: () => number;
  private readonly pageSize: number;

  constructor(
    keys: AddressBookKeys,
    transport: AddressBookTransport,
    storage: AddressBookStorage,
    clock: () => number = () => Date.now(),
    pageSize: number = FETCH_PAGE_SIZE,
  ) {
    // Own copies: close() zeroizes them without touching the caller's buffers.
    this.keys = {
      ...keys,
      sk: Uint8Array.from(keys.sk),
      encKey: Uint8Array.from(keys.encKey),
      tagKey: Uint8Array.from(keys.tagKey),
    };
    this.transport = transport;
    this.storage = storage;
    this.clock = clock;
    this.pageSize = pageSize;
  }

  /**
   * End this instance: queued work stops, keys are zeroized and the decrypted
   * state is dropped. Every later call rejects. Used when the wallet (and so
   * the key this book was opened with) goes away without a JS reload.
   */
  close(): Promise<void> {
    this.closed = true;
    // A running sync signs nothing after this (its queued steps are refused),
    // but it may still hold the keys mid-publish: wait for it too.
    const running = this.syncing;
    const done = Promise.all([
      this.queue.then(
        (): undefined => undefined,
        (): undefined => undefined,
      ),
      running?.catch((): undefined => undefined),
    ]);
    return done.then(() => {
      zeroize(this.keys.sk);
      zeroize(this.keys.encKey);
      zeroize(this.keys.tagKey);
      this.state = emptyState();
      this.loaded = false;
      this.loading = null;
      this.contactsCache = null;
      this.listeners.clear();
    });
  }

  /**
   * The contacts as they are right now, without waiting for queued work (a
   * sync can take seconds). Null until the local copy has been read once.
   */
  peek(): Contact[] | null {
    if (!this.loaded || this.closed) return null;
    this.contactsCache ??= this.liveContacts();
    return this.contactsCache;
  }

  /** The local contacts, read from storage if needed; never waits on a sync. */
  async current(): Promise<Contact[]> {
    if (this.closed) throw new Error("Address book closed");
    await this.load();
    return this.peek() ?? [];
  }

  /** Open conflicts as they are right now, without waiting for queued work. */
  async currentConflicts(): Promise<ContactConflict[]> {
    if (this.closed) throw new Error("Address book closed");
    await this.load();
    return this.conflictList();
  }

  /** Called with the new contacts after every change (edit, sync, delete). */
  subscribe(listener: (contacts: Contact[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Serialize every mutation so concurrent calls can't interleave state. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const guarded = (): Promise<T> =>
      this.closed ? Promise.reject(new Error("Address book closed")) : fn();
    const next: Promise<T> = this.queue.then(
      (): Promise<T> => guarded(),
      (): Promise<T> => guarded(),
    );
    this.queue = next.catch((): undefined => undefined);
    return next;
  }

  // One read of local storage, shared by the queue and by current().
  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.loading ??= this.readStorage().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async readStorage(): Promise<void> {
    const raw = await this.storage.load();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PersistedState;
        if (parsed?.version === 1) this.state = { ...emptyState(), ...parsed };
      } catch {
        // Unreadable cache: start empty; sync restores from relays.
      }
    }
    this.loaded = true;
    this.contactsCache = null;
  }

  private async persist(): Promise<void> {
    await this.storage.save(JSON.stringify(this.state));
    this.contactsCache = null;
    if (this.listeners.size === 0) return;
    const contacts = this.peek() ?? [];
    for (const listener of this.listeners) {
      try {
        listener(contacts);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  private open(event: NostrEvent | undefined): OpenedContact | null {
    return event ? openContact(this.keys, event) : null;
  }

  private nextCreatedAt(slot: string): number {
    const nowSec = Math.floor(this.clock() / 1000);
    const previous = this.state.events[slot]?.created_at ?? 0;
    return Math.max(nowSec, previous + 1);
  }

  /** Every live contact, sorted by name. */
  list(query?: string): Promise<Contact[]> {
    return this.run(async () => {
      await this.load();
      return this.liveContacts().filter((c) => (query ? contactMatches(c, query) : true));
    });
  }

  get(id: string): Promise<Contact | null> {
    return this.run(async () => {
      await this.load();
      const opened = this.open(this.state.events[contactSlot(this.keys, id)]);
      return opened && !opened.contact.deleted ? opened.contact : null;
    });
  }

  private liveContacts(): Contact[] {
    return Object.values(this.state.events)
      .map((event) => this.open(event)?.contact)
      .filter((c): c is Contact => Boolean(c && !c.deleted))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  pendingCount(): Promise<number> {
    return this.run(async () => {
      await this.load();
      return this.state.pending.length;
    });
  }

  add(input: ContactInput): Promise<Contact> {
    return this.run(async () => {
      await this.load();
      if (this.liveContacts().length >= MAX_CONTACTS) {
        throw new ContactValidationError(`address book is full (${MAX_CONTACTS} contacts)`);
      }
      const contact = buildContact(newContactId(), input, this.clock());
      await this.write(contact);
      return contact;
    });
  }

  update(id: string, input: ContactInput): Promise<Contact> {
    return this.run(async () => {
      await this.load();
      const current = this.open(this.state.events[contactSlot(this.keys, id)]);
      if (!current || current.contact.deleted) throw new ContactValidationError("no such contact");
      // A writer that does not know the Nuri username (older desktop tools)
      // leaves it as saved; "" removes it.
      const keep =
        input.nuriUsername === undefined && current.contact.nuriUsername
          ? { nuriUsername: current.contact.nuriUsername }
          : {};
      const contact = buildContact(id, { ...input, ...keep }, this.clock());
      await this.write(contact);
      return contact;
    });
  }

  remove(id: string): Promise<void> {
    return this.run(async () => {
      await this.load();
      const current = this.open(this.state.events[contactSlot(this.keys, id)]);
      if (!current || current.contact.deleted) throw new ContactValidationError("no such contact");
      await this.write(tombstone(id, this.clock()));
    });
  }

  private async write(contact: Contact): Promise<void> {
    const slot = contactSlot(this.keys, contact.id);
    const conflicting = this.state.conflicts[slot];
    if (conflicting) {
      // A new edit or delete made while a conflict is shown IS the user's
      // decision: it is based on the other device's version and replaces it.
      delete this.state.conflicts[slot];
      this.state.base[slot] = conflicting.created_at;
      if (!this.state.pending.includes(slot)) this.state.pending.push(slot);
    } else if (!this.state.pending.includes(slot)) {
      // First unsynced edit on this slot: remember which version it was made on.
      this.state.base[slot] = this.state.events[slot]?.created_at ?? 0;
      this.state.pending.push(slot);
    }
    const createdAt = Math.max(this.nextCreatedAt(slot), (conflicting?.created_at ?? 0) + 1);
    this.state.events[slot] = sealContact(this.keys, contact, createdAt);
    // Durable before any network: a crash here still leaves the edit pending.
    await this.persist();
    // The relays follow in the background (same fetch-first path as sync()):
    // the caller has its answer now, and anything the relays miss stays
    // pending for the next sync.
    this.scheduleSync();
  }

  /**
   * Start a sync in the background and return at once. Edits made while one
   * runs are picked up by one more sync right after it. Failures stay
   * pending; they are never thrown.
   */
  private scheduleSync(): void {
    void this.startSync().catch(() => {});
  }

  private startSync(): Promise<SyncReport> {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    const run = (async (): Promise<SyncReport> => {
      try {
        let report = await this.syncOnce();
        while (this.syncAgain && !this.closed) {
          this.syncAgain = false;
          report = await this.syncOnce();
        }
        return report;
      } finally {
        this.syncing = null;
        this.syncAgain = false;
      }
    })();
    this.syncing = run;
    return run;
  }

  /** Resolves when queued edits and any background sync are done (tests). */
  async settled(): Promise<void> {
    for (;;) {
      await this.queue;
      const running = this.syncing;
      if (!running) return;
      await running.catch(() => {});
    }
  }

  /** Fetch, merge, publish and heal now; waits for a running sync, then runs one. */
  async sync(): Promise<SyncReport> {
    if (this.closed) throw new Error("Address book closed");
    await this.run(() => this.load());
    if (this.syncing) {
      // What was pending when the caller asked may be past the running pass.
      this.syncAgain = true;
      return this.syncing;
    }
    return this.startSync();
  }

  /**
   * Fetch first, then publish. Publishing a pending edit before looking would
   * let an offline edit silently replace a newer one from another device.
   * Relay I/O happens outside the state queue; merging and bookkeeping are
   * short queued steps, so an edit never waits on a relay.
   */
  private async syncOnce(): Promise<SyncReport> {
    const fetched: RelayFetchResult[] = await Promise.all(
      this.transport.relays.map((relay) => this.fetchAll(relay)),
    );

    // Merge what came back, and pick what to publish, in one queued step.
    const merged = await this.run(async () => {
      await this.load();
      // Newest valid event per slot across all relays, and what each relay holds.
      const remoteWinner: Record<string, NostrEvent> = {};
      const relayHas: Array<Record<string, NostrEvent>> = fetched.map(() => ({}));
      let received = 0;
      fetched.forEach((result, index) => {
        for (const event of result.events) {
          const opened = openContact(this.keys, event);
          if (!opened) continue;
          received++;
          if (newer(event, relayHas[index][opened.slot])) relayHas[index][opened.slot] = event;
          if (newer(event, remoteWinner[opened.slot])) remoteWinner[opened.slot] = event;
        }
      });

      let updated = 0;
      for (const [slot, remote] of Object.entries(remoteWinner)) {
        const local = this.state.events[slot];
        if (local && local.id === remote.id) continue;
        if (this.state.pending.includes(slot)) {
          // Someone else changed this contact after the version we edited.
          if (remote.created_at > (this.state.base[slot] ?? 0)) this.state.conflicts[slot] = remote;
          continue;
        }
        if (newer(remote, local)) {
          this.state.events[slot] = remote;
          updated++;
        }
      }
      await this.persist();
      const toPublish = this.state.pending
        .filter((slot) => !this.state.conflicts[slot])
        .map((slot) => ({ slot, event: this.state.events[slot] }));
      return { relayHas, received, updated, toPublish };
    });

    // Publish outside the queue.
    const outcomes = await Promise.all(
      merged.toPublish.map(async ({ slot, event }) => {
        const results = await Promise.all(
          this.transport.relays.map((relay) =>
            this.transport.publish(relay, event).catch(() => false),
          ),
        );
        return { slot, event, ok: results.some(Boolean) };
      }),
    );

    // Clear only what was published unchanged: an edit made meanwhile stays
    // pending (the next pass sends it). Then pick what complete relays lack.
    const done = await this.run(async () => {
      const pushedSlots: string[] = [];
      let published = 0;
      let failed = 0;
      for (const { slot, event, ok } of outcomes) {
        if (!ok) {
          failed++;
          continue;
        }
        published++;
        pushedSlots.push(slot);
        if (this.state.conflicts[slot]) continue;
        if (this.state.events[slot]?.id !== event.id) {
          // Edited again while this went out: the newer edit stays pending, now
          // based on what the relays have (our own publish, not a conflict).
          this.state.base[slot] = Math.max(this.state.base[slot] ?? 0, event.created_at);
          continue;
        }
        this.state.pending = this.state.pending.filter((s) => s !== slot);
        delete this.state.base[slot];
      }
      await this.persist();
      const heal = fetched.map((result, index) => {
        if (!result.complete) return [] as NostrEvent[];
        return Object.entries(this.state.events)
          .filter(
            ([slot, event]) =>
              !this.state.pending.includes(slot) &&
              !pushedSlots.includes(slot) &&
              newer(event, merged.relayHas[index][slot]),
          )
          .map(([, event]) => event);
      });
      return { published, failed, heal, conflicts: this.conflictList() };
    });

    // Heal: every synced local event goes to each complete relay that lacks it.
    let healed = 0;
    await Promise.all(
      fetched.map(async (result, index) => {
        for (const event of done.heal[index]) {
          if (await this.transport.publish(result.relay, event).catch(() => false)) healed++;
        }
      }),
    );

    return {
      published: done.published,
      publishFailed: done.failed,
      received: merged.received,
      updated: merged.updated,
      healed,
      conflicts: done.conflicts,
      relays: fetched.map((r) => ({
        relay: r.relay,
        complete: r.complete,
        events: r.events.length,
      })),
    };
  }

  /**
   * Every event of the collection on one relay, page by page. A relay caps
   * each answer and tombstones accumulate without bound, so one request is
   * never assumed to be the whole set: page backwards with `until` to a short
   * (terminal) page. There is no page ceiling; paging always moves strictly
   * back in time, so it ends. `complete` only when it reached that page.
   */
  private async fetchAll(relay: string): Promise<RelayFetchResult> {
    const seen = new Map<string, NostrEvent>();
    const partial = (): RelayFetchResult => ({ relay, events: [], complete: false });
    let until: number | undefined;
    for (;;) {
      let result: { events: NostrEvent[]; complete: boolean };
      try {
        result = await this.transport.fetch(relay, {
          kinds: [ADDRESS_BOOK_KIND],
          authors: [this.keys.pubkey],
          "#t": [this.keys.collectionTag],
          limit: this.pageSize,
          ...(until !== undefined ? { until } : {}),
        });
      } catch {
        return partial();
      }
      // A relay that stopped answering mid-way gave a partial set; apply none
      // of it rather than a restore missing whatever the next pages held.
      if (!result.complete) return partial();
      let added = 0;
      for (const event of result.events) {
        const id = String(event.id);
        if (!seen.has(id)) {
          seen.set(id, event);
          added++;
        }
      }
      if (result.events.length < this.pageSize) {
        return { relay, events: [...seen.values()], complete: true };
      }
      const oldest = Math.min(...result.events.map((e) => e.created_at));
      // A full page that adds nothing, or that lies entirely in the second it
      // was asked up to: more than a page shares one second and `until` can't
      // page through it. Unreadable this sync — apply nothing from it.
      if (
        added === 0 ||
        (until === oldest && result.events.every((e) => e.created_at === oldest))
      ) {
        return partial();
      }
      // Inclusive: events sharing the oldest second may continue on the next page.
      until = oldest;
    }
  }

  private conflictList(): ContactConflict[] {
    return Object.entries(this.state.conflicts).flatMap(([slot, remoteEvent]) => {
      const local = this.open(this.state.events[slot])?.contact;
      const remote = this.open(remoteEvent)?.contact;
      return local && remote ? [{ id: local.id, local, remote }] : [];
    });
  }

  conflicts(): Promise<ContactConflict[]> {
    return this.run(async () => {
      await this.load();
      return this.conflictList();
    });
  }

  /** Keep one side of a conflict. "local" republishes the local edit on top. */
  resolveConflict(id: string, keep: "local" | "remote"): Promise<void> {
    return this.run(async () => {
      await this.load();
      const slot = contactSlot(this.keys, id);
      const remote = this.state.conflicts[slot];
      if (!remote) throw new ContactValidationError("no conflict for this contact");
      delete this.state.conflicts[slot];
      if (keep === "remote") {
        this.state.events[slot] = remote;
        this.state.pending = this.state.pending.filter((s) => s !== slot);
        delete this.state.base[slot];
        await this.persist();
        return;
      }
      const local = this.open(this.state.events[slot]);
      if (!local) throw new ContactValidationError("local version unreadable");
      // Re-seal after the remote version so relays replace it.
      const createdAt = Math.max(Math.floor(this.clock() / 1000), remote.created_at + 1);
      this.state.events[slot] = sealContact(this.keys, local.contact, createdAt);
      this.state.base[slot] = remote.created_at;
      await this.persist();
      this.scheduleSync();
    });
  }

  /** Encrypted export: the signed events themselves (restorable with the same key). */
  exportEncrypted(): Promise<string> {
    return this.run(async () => {
      await this.load();
      return JSON.stringify({
        format: "nuri-address-book-export-v1",
        pubkey: this.keys.pubkey,
        events: Object.values(this.state.events),
      });
    });
  }

  /** Import an encrypted export; only events this key can open are taken. */
  importEncrypted(json: string): Promise<{ imported: number; skipped: number }> {
    return this.run(async () => {
      await this.load();
      const parsed = JSON.parse(json) as { format?: string; events?: NostrEvent[] };
      if (parsed?.format !== "nuri-address-book-export-v1" || !Array.isArray(parsed.events)) {
        throw new ContactValidationError("not an address book export");
      }
      let imported = 0;
      let skipped = 0;
      for (const event of parsed.events) {
        const opened = openContact(this.keys, event);
        if (!opened || !newer(event, this.state.events[opened.slot])) {
          skipped++;
          continue;
        }
        if (this.state.pending.includes(opened.slot)) {
          // An unsynced local edit is never replaced: the imported version
          // becomes a conflict for the user to decide, like a remote one.
          this.state.conflicts[opened.slot] = event;
          imported++;
          continue;
        }
        this.state.events[opened.slot] = event;
        this.state.base[opened.slot] = 0;
        this.state.pending.push(opened.slot);
        imported++;
      }
      await this.persist();
      if (imported > 0) this.scheduleSync();
      return { imported, skipped };
    });
  }
}
