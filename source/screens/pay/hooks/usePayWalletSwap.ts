// In-page payment from the payer's browser wallet: connect, name a token, get a
// quote into the recipient's settlement currency, sign. The flow itself lives in
// services/pay/PayWalletSwapService — this hook only wires the real wallet and
// network into it and holds what the screen may show.
import { randomUUID } from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { getCacheValue, setCacheValue } from "../../../services/balance/TransactionCacheService";
import { usePayWalletConnection } from "../../../lib/pay/payWallet";
import {
  PAY_WALLET_CHAIN_IDS,
  type PayWalletDeps,
  type PayWalletProgress,
  type PayWalletQuote,
  type PayWalletSettle,
  isPayWalletPayer,
  matchesPayLinkIntent,
  isWalletRejection,
  payWalletRouteFits,
  payWithWallet,
  pendingPayWallet,
  quotePayWalletSwap,
  resumePayWithWallet,
} from "../../../services/pay/PayWalletSwapService";
import {
  fetchPayWalletHoldings,
  type PayWalletHolding,
} from "../../../services/pay/PayWalletBalanceService";
import { resolveCanonicalToken } from "../../../services/swapkit/SwapKitTokenRegistry";
import { exactBaseUnits } from "../../../lib/pay/payTarget";
import {
  asSwapKitV2OrderId,
  cancelSwapKitV2Order,
  commitSwapKitV2,
  getSwapKitV2Status,
  quoteSwapKitV2,
  submitSwapKitV2Evidence,
  type SwapKitV2QuoteOption,
} from "../../../services/swapkit/SwapKitV2Service";

const deps: PayWalletDeps = {
  quote: (args) => quoteSwapKitV2(args as Parameters<typeof quoteSwapKitV2>[0]),
  commit: (args) => commitSwapKitV2(args as unknown as Parameters<typeof commitSwapKitV2>[0]),
  submit: ({ orderId, ...rest }) =>
    submitSwapKitV2Evidence({ orderId: asSwapKitV2OrderId(orderId), ...rest }),
  status: (orderId, recoveryKey) =>
    getSwapKitV2Status(asSwapKitV2OrderId(orderId), { recoveryKey }),
  cancel: (orderId, recoveryKey) =>
    cancelSwapKitV2Order(asSwapKitV2OrderId(orderId), { recoveryKey }),
  randomId: () => randomUUID(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  // Same store PayTargetService keeps its pay-order recovery capability in.
  store: {
    get: (key) => getCacheValue(key),
    set: (key, value) => setCacheValue(key, value),
  },
};

export type PayWalletState =
  | { step: "idle" }
  | { step: "unavailable" }
  | { step: "connected"; account: `0x${string}`; chainId: number }
  | { step: "busy"; account: `0x${string}`; chainId: number }
  | {
      step: "quoted";
      account: `0x${string}`;
      chainId: number;
      quote: PayWalletQuote;
      /** Every route the holding can pay, best first; `quote.option` is the one chosen. */
      options: SwapKitV2QuoteOption[];
    }
  | { step: "no-route"; account: `0x${string}`; chainId: number }
  /** Fixed-amount link: the route needs more of the token than the wallet holds. */
  | { step: "insufficient"; account: `0x${string}`; chainId: number; quote: PayWalletQuote }
  // `otherAccount`: the connected account is not the one that accepted it;
  // only the original payer may continue it.
  | { step: "pending"; pending: PayWalletQuote; otherAccount: boolean }
  | { step: "paying"; progress: PayWalletProgress }
  | { step: "done"; progress: PayWalletProgress };

/** The connected wallet's payable tokens (LI.FI balances), for the picker. */
export type PayWalletHoldingsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; holdings: PayWalletHolding[] }
  | { status: "failed" };

export function usePayWalletSwap(
  recipient: string | null,
  settle: PayWalletSettle,
  /** A link's fixed amount, in `settle`: quoted on the recipient's side. */
  fixedAmount: string | null = null,
) {
  // The wallet the payer picked in RainbowKit (EIP-6963 extension or
  // WalletConnect), never `window.ethereum`.
  const wallet = usePayWalletConnection();
  const [state, setState] = useState<PayWalletState>(
    wallet.available ? { step: "idle" } : { step: "unavailable" },
  );
  const requestId = useRef(0);
  const [holdings, setHoldings] = useState<PayWalletHoldingsState>({ status: "idle" });
  const holdingsRequest = useRef(0);
  // Synchronous single-flight: a second press lands before React re-renders,
  // so rendered state alone cannot stop a second commit.
  const paying = useRef(false);

  const run = useCallback(async (work: () => Promise<PayWalletProgress | null>) => {
    if (paying.current) return;
    paying.current = true;
    try {
      const result = await work();
      if (result) setState({ step: "done", progress: result });
    } catch (error) {
      setState({
        step: "done",
        progress: {
          state: "failed",
          orderId: null,
          reason: isWalletRejection(error) ? "rejected" : "error",
        },
      });
    } finally {
      paying.current = false;
    }
  }, []);

  // A payment this browser started for THIS link and did not finish (reload,
  // closed tab) is picked up again on the next visit. Records are keyed by
  // recipient + currency, so another link's pending payment never shows here.
  // It resumes on its own only for the account that accepted it; any other
  // connected account sees it pending and is asked to reconnect that payer.
  const { account, chainId, getProvider } = wallet;
  useEffect(() => {
    if (!recipient || !account) return;
    const link = { recipient, settle };
    let cancelled = false;
    void (async () => {
      const pending = await pendingPayWallet(link, deps);
      if (!pending || cancelled) return;
      if (!isPayWalletPayer(pending, account)) {
        setState((current) =>
          current.step === "paying" ? current : { step: "pending", pending, otherAccount: true },
        );
        return;
      }
      // Another side or figure than this link asks for: shown, never driven
      // on its own — the payer continues it explicitly or not at all.
      if (!matchesPayLinkIntent(pending, fixedAmount)) {
        setState((current) =>
          current.step === "paying" ? current : { step: "pending", pending, otherAccount: false },
        );
        return;
      }
      const provider = await getProvider();
      if (!provider || cancelled) return;
      setState({ step: "paying", progress: { state: "waiting", orderStatus: "RESUMING" } });
      await run(() =>
        resumePayWithWallet(link, account, provider, deps, (progress) =>
          setState({ step: "paying", progress }),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [recipient, settle, run, account, getProvider, fixedAmount]);

  // The picked wallet and chain drive the panel: connecting (or switching
  // account/network in the wallet) moves it to "connected" for that pair,
  // dropping any quote made for another account or chain — including one
  // still in flight, which must never land for the previous identity.
  const identity = useRef<string | null>(null);
  useEffect(() => {
    if (!wallet.available) return;
    const next = account && chainId ? `${account.toLowerCase()}:${chainId}` : null;
    if (identity.current !== next) {
      identity.current = next;
      requestId.current += 1;
    }
    setState((current) => {
      if (current.step === "paying" || current.step === "done" || current.step === "pending") {
        return current;
      }
      if (!account || !chainId) return { step: "idle" };
      if ("account" in current && current.account === account && current.chainId === chainId) {
        return current;
      }
      return { step: "connected", account, chainId };
    });
  }, [wallet.available, account, chainId]);

  // What the connected account holds, re-read whenever the account changes:
  // the payer picks from this list, never types a token.
  const loadHoldings = useCallback(async (owner: `0x${string}` | null) => {
    const id = ++holdingsRequest.current;
    if (!owner) {
      setHoldings({ status: "idle" });
      return;
    }
    setHoldings({ status: "loading" });
    const list = await fetchPayWalletHoldings(owner);
    if (holdingsRequest.current !== id) return;
    setHoldings(list ? { status: "ready", holdings: list } : { status: "failed" });
  }, []);

  useEffect(() => {
    void loadHoldings(account);
  }, [account, loadHoldings]);

  const refreshHoldings = useCallback(() => {
    void loadHoldings(account);
  }, [account, loadHoldings]);

  const connect = useCallback(() => {
    if (!wallet.available) {
      setState({ step: "unavailable" });
      return;
    }
    wallet.openConnect();
  }, [wallet]);

  /**
   * Quote `amount` of a token the payer holds (picked from their balances).
   * The token must be the canonical contract for its symbol on that chain —
   * the one SwapKit's `SYMBOL_CHAIN` id resolves to — and the amount at most
   * the balance, both exact.
   */
  /**
   * Quote a token the payer holds (picked from their balances). Without a
   * fixed amount, `amount` is what they spend (at most the balance). On a
   * fixed-amount link the recipient's figure is quoted instead and the spend
   * the route asks for must fit the balance. Either way the token must be the
   * canonical contract for its symbol on that chain.
   */
  const quote = useCallback(
    async (holding: PayWalletHolding, amount: string) => {
      if (!recipient) return;
      if (
        state.step !== "connected" &&
        state.step !== "quoted" &&
        state.step !== "no-route" &&
        state.step !== "insufficient"
      )
        return;
      const { account, chainId } = state;
      // An unfinished payment on this link comes first: it is shown and
      // resumed, never replaced by a new quote the payer might confirm.
      const pending = await pendingPayWallet({ recipient, settle }, deps);
      if (pending) {
        setState({ step: "pending", pending, otherAccount: !isPayWalletPayer(pending, account) });
        return;
      }
      if (!fixedAmount) {
        const units = exactBaseUnits(amount, holding.decimals);
        if (units === null || units <= 0n || units > holding.units) return;
      }
      const id = ++requestId.current;
      setState({ step: "busy", account, chainId });
      try {
        const canonical = PAY_WALLET_CHAIN_IDS.includes(holding.chainId)
          ? await resolveCanonicalToken(holding.chainId, holding.symbol)
          : null;
        const token =
          canonical &&
          canonical.address.toLowerCase() === holding.address.toLowerCase() &&
          canonical.decimals === holding.decimals
            ? {
                chainId: holding.chainId,
                address: holding.address,
                decimals: holding.decimals,
                symbol: holding.symbol,
              }
            : null;
        const accepted = token
          ? await quotePayWalletSwap(
              fixedAmount
                ? { token, amount: fixedAmount, side: "settle", payer: account, settle, recipient }
                : { token, amount, payer: account, settle, recipient },
              deps,
            )
          : null;
        if (requestId.current !== id) return;
        // On a fixed-amount link the route decides the spend: it must fit.
        const spend = accepted
          ? exactBaseUnits(accepted.option.depositAmount, holding.decimals)
          : null;
        if (accepted && fixedAmount && (spend === null || spend > holding.units)) {
          const { options: _alternatives, ...quote } = accepted;
          setState({ step: "insufficient", account, chainId, quote });
          return;
        }
        if (!accepted) {
          setState({ step: "no-route", account, chainId });
          return;
        }
        const { options: routes, ...quote } = accepted;
        // Only routes this holding can pay are offered: an alternative that
        // spends more than it holds never reaches commit or a wallet prompt.
        const options = routes.filter((option) => payWalletRouteFits(option, holding));
        setState({ step: "quoted", account, chainId, quote, options });
      } catch {
        if (requestId.current === id) setState({ step: "no-route", account, chainId });
      }
    },
    [recipient, settle, state, fixedAmount],
  );

  /** Pick another of the quoted routes, as the swap screens' "Show more" does. */
  const selectOption = useCallback((optionId: string) => {
    setState((current) => {
      if (current.step !== "quoted") return current;
      // `options` holds only routes the holding can pay.
      const option = current.options.find((candidate) => candidate.optionId === optionId);
      return option ? { ...current, quote: { ...current.quote, option } } : current;
    });
  }, []);

  const pay = useCallback(async () => {
    if (state.step !== "quoted") return;
    const provider = await getProvider();
    // The quote is bound to the account and chain it was made for.
    if (!provider || account !== state.account || chainId !== state.chainId) return;
    const accepted = state.quote;
    setState({ step: "paying", progress: { state: "waiting", orderStatus: "COMMITTING" } });
    await run(() =>
      payWithWallet(accepted, provider, deps, (progress) => setState({ step: "paying", progress })),
    );
  }, [state, run, getProvider, account, chainId]);

  /** Continue this link's unfinished payment, exactly as it was accepted. */
  const resume = useCallback(async () => {
    if (!recipient) return;
    const link = { recipient, settle };
    const pending = await pendingPayWallet(link, deps);
    const provider = await getProvider();
    // Only the account that accepted the payment may continue it: otherwise
    // the wallet picker opens so the payer can switch back to it.
    if (!pending || !provider || !account || !isPayWalletPayer(pending, account)) {
      wallet.openConnect();
      return;
    }
    setState({ step: "paying", progress: { state: "waiting", orderStatus: "RESUMING" } });
    await run(() =>
      resumePayWithWallet(link, account, provider, deps, (progress) =>
        setState({ step: "paying", progress }),
      ),
    );
  }, [recipient, settle, run, getProvider, wallet, account]);

  // Back to the wallet that is connected NOW, never an identity kept in state.
  const reset = useCallback(() => {
    requestId.current += 1;
    setState(account && chainId ? { step: "connected", account, chainId } : { step: "idle" });
  }, [account, chainId]);

  return { state, holdings, refreshHoldings, connect, quote, selectOption, pay, resume, reset };
}
