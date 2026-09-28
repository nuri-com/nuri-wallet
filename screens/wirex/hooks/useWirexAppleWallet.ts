// screens/wirex/hooks/useWirexAppleWallet.ts
// The manual "Add to Apple Wallet" helper behind WirexAppleWalletModal. Wirex
// has no in-app provisioning, so this is reveal-PAN + auto-copy + deep-link to
// the Wallet app, and the modal renders the manual steps. Extracted from
// its screen so every surface offering the button drives it identically.
//
// SECURITY: PAN / expiry / CVV live in this hook's state ONLY while the sheet is
// open. `close()` bumps a generation counter first, so a reveal still in flight
// can neither re-show nor re-copy the PAN afterwards. Nothing here is logged.
import { useCallback, useRef, useState } from "react";
import { Linking, Platform } from "react-native";
import { copyToClipboard } from "../../../lib/copyToClipboard";
import { getEthereumAddress } from "../../../lib/secureKeyStorage";
import { type WirexCardDetailsResult, wirexService } from "../../../services/wirex/WirexService";

/**
 * Where "open the wallet app" goes. Apple's wallet answers a scheme; Google's is
 * reached through its own https address, which opens the installed app and
 * otherwise lands on the web page that explains it — either way the copied card
 * number is already on the clipboard.
 *
 * A PWA reports `web` on both phones, so the platform is read from the browser
 * there rather than from React Native.
 */
function walletAppUrl(): string {
  const APPLE = "wallet://";
  const GOOGLE = "https://wallet.google.com/";
  if (Platform.OS === "ios") return APPLE;
  if (Platform.OS === "android") return GOOGLE;
  const agent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /iPhone|iPad|iPod/i.test(agent) ? APPLE : GOOGLE;
}

export type WirexAppleWalletState = {
  visible: boolean;
  revealing: boolean;
  details: WirexCardDetailsResult | null;
  /** Reveal the PAN for `cardId`, copy it, and show the manual steps. */
  open: (cardId: string) => Promise<void>;
  /** Re-copy the PAN from the sheet. */
  copyNumber: () => void;
  /** Copy the PAN and deep-link into the Wallet app. */
  openWalletApp: () => Promise<void>;
  close: () => void;
};

export function useWirexAppleWallet(): WirexAppleWalletState {
  const [visible, setVisible] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [details, setDetails] = useState<WirexCardDetailsResult | null>(null);
  const generationRef = useRef(0);

  const open = useCallback(async (cardId: string) => {
    if (!cardId) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    setVisible(true);
    setRevealing(true);
    setDetails(null);
    try {
      const wallet = await getEthereumAddress();
      if (!wallet) throw new Error("no_wallet");
      const d = await wirexService.revealCardDetails({ wallet, cardId });
      // Superseded by a close or a newer reveal while we awaited: never re-show
      // or re-copy the PAN.
      if (generationRef.current !== generation) return;
      setDetails(d);
      if (d.cardNumber) void copyToClipboard(d.cardNumber); // never log the PAN
    } catch {
      // modal shows the unavailable state
      if (generationRef.current === generation) setDetails(null);
    } finally {
      if (generationRef.current === generation) setRevealing(false);
    }
  }, []);

  const copyNumber = useCallback(() => {
    if (details?.cardNumber) void copyToClipboard(details.cardNumber);
  }, [details]);

  const openWalletApp = useCallback(async () => {
    if (details?.cardNumber) void copyToClipboard(details.cardNumber);
    try {
      await Linking.openURL(walletAppUrl());
    } catch {}
  }, [details]);

  const close = useCallback(() => {
    // Invalidate an in-flight reveal so it can't repopulate after close.
    generationRef.current += 1;
    setVisible(false);
    setRevealing(false);
    setDetails(null); // don't keep PAN/expiry/CVV in memory after close
  }, []);

  return { visible, revealing, details, open, copyNumber, openWalletApp, close };
}
