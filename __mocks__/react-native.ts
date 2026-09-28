// Minimal React Native mock for vitest
export const Platform = { OS: "ios", select: (obj: Record<string, unknown>) => obj.ios };
export const AppState = { currentState: "active", addEventListener: () => ({ remove: () => {} }) };
export const Linking = { openURL: async () => {} };
// Read by PasskeyNativeModuleService (NativeModules.PasskeyModule) — absent is a valid value
// (web/iOS path), but the NativeModules object itself must exist.
export const NativeModules: Record<string, unknown> = {};
export default { Platform, AppState, Linking, NativeModules };
