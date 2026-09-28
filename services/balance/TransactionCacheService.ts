import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";

const DB_NAME = "nuri-cache.db";
const TABLE = "transaction_cache";

let dbPromise: Promise<SQLiteDatabase> | null = null;
let initPromise: Promise<void> | null = null;

const getDb = () => {
  if (!dbPromise) dbPromise = openDatabaseAsync(DB_NAME);
  return dbPromise;
};

const ensureInit = async (db: SQLiteDatabase) => {
  if (!initPromise) {
    initPromise = db.execAsync(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    );
  }
  return initPromise;
};

const parsePayload = <T>(payload?: string | null): T | null => {
  if (!payload) return null;
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
};

export const getCacheValue = async <T>(key: string): Promise<T | null> => {
  const db = await getDb();
  await ensureInit(db);
  const row = await db.getFirstAsync<{ payload: string }>(
    `SELECT payload FROM ${TABLE} WHERE cache_key = ?`,
    [key],
  );
  return parsePayload<T>(row?.payload ?? null);
};

export const setCacheValue = async <T>(key: string, value: T): Promise<void> => {
  const db = await getDb();
  await ensureInit(db);
  const payload = JSON.stringify(value);
  await db.runAsync(
    `INSERT OR REPLACE INTO ${TABLE} (cache_key, payload, updated_at) VALUES (?, ?, ?)`,
    [key, payload, Date.now()],
  );
};

export const deleteCacheKeys = async (keys: string[]): Promise<void> => {
  if (!keys.length) return;
  const db = await getDb();
  await ensureInit(db);
  const placeholders = keys.map(() => "?").join(",");
  await db.runAsync(`DELETE FROM ${TABLE} WHERE cache_key IN (${placeholders})`, keys);
};

export const deleteCacheDatabase = async (): Promise<void> => {
  try {
    if (dbPromise) {
      const db = await dbPromise;
      try {
        await db.closeAsync();
      } catch {}
    }
  } catch {}
  dbPromise = null;
  initPromise = null;
  try {
    await deleteDatabaseAsync(DB_NAME);
  } catch {}
};
