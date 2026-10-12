// Pay-link wallet connection — WEB build (RainbowKit + wagmi).
//
// The payer picks their wallet from RainbowKit's modal: browser extensions are
// discovered through EIP-6963 (one entry per installed wallet, so MetaMask and
// Rabby never overwrite each other the way a shared `window.ethereum` does),
// and phone wallets connect over WalletConnect by QR. Hardware wallets work
// through the wallet that fronts them (Ledger Live, or a Trezor behind
// MetaMask/Rabby/Frame).
//
// The payment itself never goes through wagmi's hooks: the connected wallet's
// own EIP-1193 provider is handed to services/pay/PayWalletSwapService, which
// binds every step to the accepted route before the wallet is asked to sign.
//
// Only the pay page's root (App.tsx PayLinkApp) mounts this provider; the
// signed-in wallet never does. Native builds resolve `payWallet.tsx` instead,
// so none of these packages reach the iOS/Android bundle.
import "@rainbow-me/rainbowkit/styles.css";
import {
  RainbowKitProvider,
  connectorsForWallets,
  lightTheme,
  useAccountModal,
  useConnectModal,
} from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  frameWallet,
  injectedWallet,
  ledgerWallet,
  metaMaskWallet,
  rabbyWallet,
  rainbowWallet,
  trustWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { http, WagmiProvider, createConfig, useAccount, useDisconnect } from "wagmi";
import { disconnect } from "wagmi/actions";
import { arbitrum, base, gnosis, mainnet, optimism, polygon } from "wagmi/chains";
import { WALLETCONNECT_PROJECT_ID } from "../../config/endpoints";
import { getChainRpcUrl } from "../rpc/chainRpc";
import type { ChainId } from "../tokens";
import type { Eip1193Provider } from "../../services/pay/PayWalletSwapService";
import type { PayWalletConnection } from "./payWalletTypes";

/** The page's own origin: the name and icon wallets show for this dapp. */
const PAY_WALLET_APP_URL =
  typeof window !== "undefined" && window.location?.origin
    ? window.location.origin
    : "https://app.nuri.com";

/** The chains a payer can pay from — exactly PAY_WALLET_CHAIN_IDS. */
const CHAINS = [mainnet, base, arbitrum, optimism, polygon, gnosis] as const;

/**
 * Reads go to the same RPCs the app already uses (and the page CSP already
 * allows), never to wagmi's public defaults.
 */
const transports = Object.fromEntries(
  CHAINS.map((chain) => [chain.id, http(getChainRpcUrl(chain.id as ChainId))]),
) as Record<(typeof CHAINS)[number]["id"], ReturnType<typeof http>>;

/** Whether this build can offer the wallet modal at all. */
export const PAY_WALLET_AVAILABLE = WALLETCONNECT_PROJECT_ID.length > 0;

/**
 * Built on first mount of PayWalletProvider, never at import: App.tsx imports
 * this module for every web route, and creating the WalletConnect connectors
 * contacts Reown (pulse, wallet list). Only the pay page may do that.
 */
function createPayWalletConfig() {
  return createConfig({
    chains: CHAINS,
    transports,
    // EIP-6963: every installed extension announces itself separately.
    multiInjectedProviderDiscovery: true,
    ssr: false,
    connectors: connectorsForWallets(
      [
        {
          groupName: "Wallets",
          wallets: [
            metaMaskWallet,
            rabbyWallet,
            frameWallet,
            rainbowWallet,
            coinbaseWallet,
            trustWallet,
            ledgerWallet,
            walletConnectWallet,
            injectedWallet,
          ],
        },
      ],
      {
        appName: "Nuri",
        appDescription: "Pay with any token",
        // Wallets show this page's identity from here (WalletConnect) or from
        // the page's own icon links (extensions). Absolute, same origin.
        appUrl: PAY_WALLET_APP_URL,
        appIcon: `${PAY_WALLET_APP_URL}/icons/icon-192.png`,
        projectId: WALLETCONNECT_PROJECT_ID,
      },
    ),
  });
}

let created: { config: ReturnType<typeof createPayWalletConfig>; queryClient: QueryClient } | null =
  null;

/** The pay page's wagmi config + query client, built once on first use. */
export function payWalletClients() {
  created ??= { config: createPayWalletConfig(), queryClient: new QueryClient() };
  return created;
}

/** Whether anything has built the WalletConnect connectors yet (runtime check). */
export function payWalletClientsCreated(): boolean {
  return created !== null;
}

/** What wagmi, WalletConnect and RainbowKit keep in this origin's storage. */
const PAY_WALLET_STORAGE = /^(wagmi\.|wc@2:|rk-)/;

/**
 * Logout and wallet replacement: the next user must not inherit this one's
 * connected wallet. Disconnects, drops the config and every stored session.
 */
export async function resetPayWallet(): Promise<void> {
  const clients = created;
  created = null;
  if (clients) await disconnect(clients.config).catch(() => {});
  if (typeof localStorage === "undefined") return;
  for (const key of Object.keys(localStorage)) {
    if (PAY_WALLET_STORAGE.test(key)) localStorage.removeItem(key);
  }
}

export function PayWalletProvider({
  children,
}: {
  children: React.ReactNode;
  /** Native only (AppKit's modal); RainbowKit opens its modal from any provider. */
  modal?: boolean;
}) {
  const [clients] = useState(() => (PAY_WALLET_AVAILABLE ? payWalletClients() : null));
  if (!clients) return <>{children}</>;
  return (
    <WagmiProvider config={clients.config}>
      <QueryClientProvider client={clients.queryClient}>
        <RainbowKitProvider theme={lightTheme({ borderRadius: "large" })} modalSize="compact">
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function useConnectedWallet(): PayWalletConnection {
  const { address, chainId, connector, isConnected } = useAccount();
  const { openConnectModal, connectModalOpen } = useConnectModal();
  // Once connected RainbowKit withholds the connect modal; the account modal
  // is where the payer switches or disconnects the wallet.
  const { openAccountModal, accountModalOpen } = useAccountModal();
  const { disconnectAsync } = useDisconnect();
  const openConnect = useCallback(
    () => (openConnectModal ?? openAccountModal)?.(),
    [openConnectModal, openAccountModal],
  );
  const getProvider = useCallback(async (): Promise<Eip1193Provider | null> => {
    if (!connector) return null;
    const provider = (await connector.getProvider()) as Eip1193Provider | undefined;
    return provider && typeof provider.request === "function" ? provider : null;
  }, [connector]);
  const disconnect = useCallback(async () => {
    await disconnectAsync().catch(() => {});
  }, [disconnectAsync]);
  return useMemo(
    () => ({
      available: true,
      account: isConnected && address ? (address as `0x${string}`) : null,
      walletName: isConnected ? connector?.name || null : null,
      chainId: isConnected && chainId ? chainId : null,
      openConnect,
      pickerOpen: connectModalOpen || accountModalOpen,
      getProvider,
      disconnect,
    }),
    [
      isConnected,
      address,
      connector?.name,
      chainId,
      openConnect,
      connectModalOpen,
      accountModalOpen,
      getProvider,
      disconnect,
    ],
  );
}

const UNAVAILABLE: PayWalletConnection = {
  available: false,
  account: null,
  walletName: null,
  chainId: null,
  openConnect: () => {},
  pickerOpen: false,
  getProvider: async () => null,
  disconnect: async () => {},
};

function useNoWallet(): PayWalletConnection {
  return UNAVAILABLE;
}

/** The connected wallet, or an unavailable stub when no project id is configured. */
export const usePayWalletConnection: () => PayWalletConnection = PAY_WALLET_AVAILABLE
  ? useConnectedWallet
  : useNoWallet;
