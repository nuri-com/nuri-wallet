// Wallet sessions earlier versions stored: Add money from another wallet kept a
// connected wallet (Reown AppKit on native, RainbowKit on the web build). The
// app no longer connects one, but a session it left behind belongs to the user
// who connected it, so logout and wallet replacement still clear it.
import AsyncStorage from "@react-native-async-storage/async-storage";

/** Where the native wallet picker kept its sessions. */
const NATIVE_PREFIX = "@nuri:appkit:";

/** What wagmi, WalletConnect and RainbowKit kept in the web origin's storage. */
const WEB_KEYS = /^(wagmi\.|wc@2:|rk-)/;

export async function resetPayWallet(): Promise<void> {
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(NATIVE_PREFIX));
  if (keys.length) await AsyncStorage.multiRemove(keys);
  if (typeof localStorage === "undefined") return;
  for (const key of Object.keys(localStorage)) {
    if (WEB_KEYS.test(key)) localStorage.removeItem(key);
  }
}
