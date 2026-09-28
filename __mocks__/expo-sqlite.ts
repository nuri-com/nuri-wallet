// Minimal expo-sqlite stub for node-side tests. No test asserts against a real database; the
// functions exist so modules that import expo-sqlite statically stay parseable under vitest.
const notImplemented = async (): Promise<never> => {
  throw new Error("expo-sqlite stub: no database in the test environment");
};

export const openDatabaseAsync = notImplemented;
export const deleteDatabaseAsync = notImplemented;
export type SQLiteDatabase = unknown;
export default {};
