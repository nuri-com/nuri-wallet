// @screen app.move
// "Move" — the swap sheet, built to the designer's Move board.
//
// TWO cards hold the two ends, and the two amounts are ONE control: whichever
// side has focus is the card that GROWS and carries the big figure, the other
// collapses to a strip stating the same amount in its own currency. Tapping a
// card moves the focus — that is how the user decides whether they are
// expressing the move in the source or the destination currency. The cards
// resize together, animated, so the figure travels between them.
//
// Each CARD is one press area — tapping anywhere in it starts expressing the
// move in that side's currency — and only the select trigger escapes, to open
// that side's account picker. Between the cards runs the seam: a zero-flow
// Bleed band riding the boundary, with the direction control centred on it. The
// arrow never turns; it swaps which end is which.
//
// Below: the shared AmountKeypad and the Cancel · Next row, the CTA disabled
// until there is a destination and an amount. Nothing scrolls — the cards take
// exactly the height the docked keypad and buttons leave.
//
// Next prices the move through the swap contract and shows what it would pay
// out, under the same card. That list is the confirmation: the prices exist
// only on this screen until the user accepts one, and accepting is the single
// action that may move money. Every pair the contract can price takes exactly
// these steps, so no direction has a screen or a shortcut of its own.
//
// The pair is chosen in RAILS, not tokens: BTC is two balances here (arkade and
// the legacy on-chain wallet) and so is euro (the EURC wallet and Wirex), and
// they settle through different services — a token picker would leave the rail
// ambiguous exactly where it matters. A rail the swap contract has no asset for
// (the Wirex account) is a plain transfer, not an exchange, and is handed back
// to the caller.
import type React from "react";
import { Fragment, useEffect, useState } from "react";
import { LayoutAnimation, Platform, View as RNView, UIManager } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Bleed,
  Button,
  ButtonText,
  Footer,
  Header,
  IconButton,
  NuriScope,
  Pressable,
  Scroll,
  SelectTrigger,
  SelectTriggerAvatar,
  SelectTriggerChevron,
  SelectTriggerLabel,
  SelectTriggerValue,
  Text,
  Topbar,
  TopbarTrailing,
  View,
} from "@ds";
import AmountKeypad from "../../components/AmountKeypad";
import { paymentTimingStart } from "../../lib/paymentTiming";
import SwapProcessingView, { SwapTryAgainView } from "../../components/SwapProcessingView";
import SwapRouteChoices from "../../components/SwapRouteChoices";
import { carriedAmountText } from "../../lib/amounts";
import { swapRouteCardDetail } from "../../lib/formatting";
import { t } from "../../lib/i18n";
import { reportErrorToSupport, wasReportedToSupport } from "../../lib/support/reportErrorToSupport";
import { isUserCancelledAuth } from "../../lib/support/isUserCancelledAuth";
import { isUnresolvedCommitOutcome } from "../../services/swapkit/SwapKitV2CommitFlow";
import ChoiceSheet from "../../components/ChoiceSheet";
import DsSheetHost from "../../components/DsSheetHost";
import { useFiatAmountInput } from "../../lib/useFiatAmountInput";
import type { SwapAssetId } from "../../services/swapkit/SwapContract";
import { moveSourceAmount, moveSpendAmount, moveTransferBounds } from "./moveSpend";
import { moveRailPairOpen, moveRailPickOpen } from "./movePairs";
import { type MoveSwapExecuted, useMoveSwap } from "./hooks/useMoveSwap";
import { useMoveSwapBounds } from "./hooks/useMoveSwapBounds";
import { swapBoundBlock } from "../../services/swapkit/SwapAmountBounds";

/** One side of a move: a balance that can give or take. */
export type SwapRail = {
  key: string;
  label: string;
  /** The rail's own logo — every rail has one, so no rail draws an icon. */
  image: number;
  /** This rail's balance, formatted. */
  amount: string;
  /**
   * The same balance as a number, in this rail's own unit (sats for bitcoin,
   * whole currency for the rest). What the card can actually spend — a price
   * for money that is not there is a price nothing could ever execute, and the
   * user only found out after the route list came back.
   */
  available?: number;
  /**
   * Glyph shown before the card's figures — "₿", "€", "$". The card's two
   * amounts are the largest text on the sheet and sit next to a keypad; a
   * three-letter code there eats the room the number needs. The rail picker's
   * rows below still state `amount` with its ISO code.
   */
  unit: string;
  /** Sats have no sub-unit, so their placeholder is "0", not "0.00". */
  whole: boolean;
  /**
   * What this balance is called in the swap contract. Absent for a rail no swap
   * engine can name, which moves by plain transfer and never has a price.
   */
  asset?: SwapAssetId;
  /**
   * Which bitcoin wallet pays, for the two rails that share one asset id. The
   * contract cannot tell them apart from the asset alone.
   */
  sendSource?: "arkade" | "onchain";
  /**
   * Where a swap INTO this rail settles. Same reason: one asset id, two rails,
   * and without an address the swap settles to whichever the service defaults
   * to — the other one.
   */
  settleAddress?: string;
  /**
   * Which of the app's own balances this rail IS, for a swap that settles on it.
   * The address alone tells the durable order nothing about whose figure needs
   * correcting when it finally settles.
   */
  settleKind?: "card";
};

type Side = "from" | "to";

/** What the caller did with a pair the swap contract cannot price. */
export type MoveOutcome =
  // The money moved (or is broadcast) — this sheet is done.
  | "transferred"
  // Another screen took over and owns the rest; this sheet is already closing.
  | "handed-off"
  // Nothing ran: the pair has no transfer here. The sheet stays as it was.
  | "unhandled";

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Re-open this sheet after a pre-commit swap failure that closed it. */
  onReopenOnFailure?: () => void;
  rails: SwapRail[];
  /**
   * The destination keys a source may reach. Null — the default — means every
   * rail: which pairs work is normally answered by pricing them. Only a source
   * whose exits are FIXED names them, and the caller is what knows that.
   */
  destinationsFor?: (fromKey: string) => string[] | null;
  fromKey: string | null;
  toKey: string | null;
  onPickFrom: (key: string) => void;
  onPickTo: (key: string) => void;
  /**
   * The typed amount expressed on the OTHER side, formatted — what the
   * unfocused half shows. Null while the pair or the rate is unknown.
   */
  counterAmount: (typed: number, focus: Side) => string | null;
  /**
   * Any figure on this card, written the way its rail writes figures. The card
   * has ONE way to write an amount: the counter and the quote are the same
   * number seen from two moments, and a second local formatter had them
   * disagreeing about grouping and rounding inside one control.
   */
  railAmount: (value: number, railKey: string) => string;
  /**
   * The same conversion as a raw number, used when the focus moves: the typed
   * amount is re-expressed in the newly focused side's unit, so switching sides
   * never silently reinterprets "25 euro" as "25 sats".
   */
  counterValue: (typed: number, focus: Side) => number | null;
  /** Swap the two ends — the control on the dividing line. */
  onFlip: () => void;
  /**
   * A move with no exchange in it — a pair where one end has no swap asset —
   * with the amount expressed on the SOURCE side. There is no price to fetch
   * or accept for those, so they are handed back to the caller that transfers
   * them.
   *
   * The answer says what actually happened, because "no exchange" is not the
   * same as "handled": the caller transfers some of these pairs, hands others
   * to a screen of their own, and has nothing at all for the rest. A sheet that
   * assumed success closed itself over a move that never ran.
   */
  onConfirm: (sourceAmount: number) => MoveOutcome | Promise<MoveOutcome>;
  /** A priced move that ran, with what it bought — for the destination's books. */
  onExecuted?: (result: MoveSwapExecuted) => void;
  /** The end fixed by the caller: stated, not picked, and the flip is not offered. */
  locked?: Side | null;
};

// Both ends are always seeded with a real rail, so there is no unknown state to
// draw. The DS select trigger IS the chooser: the side is its label, the rail its
// value, and pressing it anywhere opens that side's picker.
const RailTrigger: React.FC<{
  rail: SwapRail | null;
  side: Side;
  availableAmount?: string;
  onPress: () => void;
}> = ({ rail, side, availableAmount, onPress }) => {
  const value = rail
    ? `${rail.label}${side === "from" && availableAmount ? ` (${availableAmount})` : ""}`
    : "";
  return (
    <SelectTrigger
      onPress={onPress}
      accessibilityLabel={
        side === "from"
          ? t("screen.MoveSheet.sourceAccountA11yLabel")
          : t("screen.MoveSheet.destinationAccountA11yLabel")
      }
      {...(value ? { accessibilityValue: value } : {})}
    >
      <SelectTriggerLabel>
        {side === "from" ? t("screen.MoveSheet.from") : t("screen.MoveSheet.to")}
      </SelectTriggerLabel>
      {rail ? <SelectTriggerAvatar source={rail.image} /> : null}
      <SelectTriggerValue>{value}</SelectTriggerValue>
      <SelectTriggerChevron name="caret-down" />
    </SelectTrigger>
  );
};

const MoveSheet: React.FC<Props> = ({
  visible,
  onClose,
  onReopenOnFailure,
  rails,
  destinationsFor,
  fromKey,
  toKey,
  onPickFrom,
  onPickTo,
  counterAmount,
  counterValue,
  railAmount,
  onFlip,
  onConfirm,
  onExecuted,
  locked = null,
}) => {
  const insets = useSafeAreaInsets();
  // Which side the keypad is typing into. The other side shows its value small
  // in its own row.
  const [focus, setFocus] = useState<Side>("from");
  // The keypad's own height, held so the price can take the same box.
  const [keypadHeight, setKeypadHeight] = useState(0);
  // Which side's picker the bottom sheet is choosing for; null = closed.
  const [picking, setPicking] = useState<Side | null>(null);
  // A transfer runs HERE, not behind a closed sheet: it is money leaving, and a
  // failure the user never sees is a failure they retry blind. "unresolved" is
  // the withdrawal whose outcome is unknown after the funds may have moved —
  // that one is never offered a retry, because a second attempt could pay twice.
  const [transfer, setTransfer] = useState<"idle" | "failed" | "unresolved">("idle");
  // The accepted amount of a FAILED transfer, kept because closing the sheet
  // clears the input. Try again replays this figure, never a cleared 0.
  const [failedTransferAmount, setFailedTransferAmount] = useState<number | null>(null);
  const { amount, setAmount, handleChangeText, parsedAmount } = useFiatAmountInput();
  const swap = useMoveSwap({
    onExecuted: (result) => {
      // The caller books the destination side before this closes: it is the only
      // side that knows which rail was picked, and the arriving money has no
      // other owner until the tracker settles minutes later.
      onExecuted?.(result);
      onClose();
    },
    // A pre-commit failure (nothing moved) arrives after the snappy accept has
    // already closed the sheet — reopen so it is never swallowed.
    onPreHandoffFailure: onReopenOnFailure,
    // The price moved before the commit: closing cleared the amount, so put the
    // same move back and reopen on its fresh price for the user to accept.
    onRequote: (request) => {
      setFocus("from");
      setAmount(carriedAmountText(request.amount, from?.whole === true));
      onReopenOnFailure?.();
    },
  });
  const { reset: resetSwap } = swap;

  const from = rails.find((r) => r.key === fromKey) ?? null;
  const to = rails.find((r) => r.key === toKey) ?? null;
  // A pair with no route or transfer is never held: any source may be picked
  // (the caller moves the destination onto one it reaches), and a destination
  // the source cannot reach is greyed out with the reason.
  const pairOpen = (fromRail: string, toRail: string) =>
    moveRailPairOpen(destinationsFor, fromRail, toRail);
  const pairOpenFor = (side: Side, key: string): boolean =>
    moveRailPickOpen(destinationsFor, { fromKey, toKey }, side, key);

  useEffect(() => {
    if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  // The sheet stays mounted between opens; a stale amount would survive into
  // the next pair.
  useEffect(() => {
    if (!visible) {
      setAmount("");
      setFocus("from");
      setPicking(null);
      // A failed/unresolved transfer is deliberately left alone: it resolves
      // after the snappy close and reopens the sheet to state itself, exactly
      // as swap.failed survives resetSwap. Starting a new move clears it.
      resetSwap();
    }
  }, [visible, setAmount, resetSwap]);

  // A price is a price for ONE move, so every edit to the move withdraws it.
  // These are the only ways the move can change, which is why they wrap the
  // change instead of an effect watching the result of one.
  const changeAmount = (text: string) => {
    setTransfer("idle");
    // Editing the move retires the failed one: its retained amount must not
    // outlive it and be replayed into a different transfer.
    setFailedTransferAmount(null);
    resetSwap();
    handleChangeText(text);
  };
  const pickRail = (side: Side, key: string) => {
    setTransfer("idle");
    setFailedTransferAmount(null);
    resetSwap();
    if (side === "from") onPickFrom(key);
    else onPickTo(key);
  };

  const focusedRail = focus === "from" ? from : to;
  // The figure carries the focused side's unit — which currency the user is
  // expressing the move in is the whole point of the control.
  const figure =
    `${focusedRail?.unit ?? ""} ${amount || (focusedRail?.whole ? "0" : "0.00")}`.trim();
  // The unfocused half shows the SAME amount expressed on its own side, not its
  // balance: that is what makes the two fields one control.
  const counter = counterAmount(parsedAmount, focus) ?? "";

  // The typed amount is an amount of MONEY. Anything that changes which rail the
  // focused half points at — moving the focus, or flipping the pair — has to
  // re-express it, or the same digits silently become a different sum.
  // BOTH paths go through here; handling only one is what turned "50 euro" into
  // "50 sats" on a flip.
  const carryAmountThrough = (change: () => void) => {
    const carried = parsedAmount > 0 ? counterValue(parsedAmount, focus) : null;
    // The carried figure is the amount expressed on the OTHER side, so that
    // rail's precision is the one it has to keep — whole units for sats, cents
    // for every fiat rail, whatever the figure's magnitude.
    const carriedRail = focus === "from" ? to : from;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    resetSwap();
    change();
    if (carried !== null) {
      // changeAmount applies the same cap the keypad does.
      changeAmount(carriedAmountText(carried, carriedRail?.whole === true));
    }
  };

  const focusSide = (side: Side) => {
    if (side === focus) return;
    carryAmountThrough(() => setFocus(side));
  };

  // Flipping swaps the rails while the focus stays on the same half, so the
  // focused half ends up pointing at the OTHER asset — the same conversion the
  // focus change needs.
  const flip = () => carryAmountThrough(onFlip);

  // What leaves the source, whichever side the user chose to express the move
  // in — a price is always asked for on the deposit side. Typing the source's
  // stated (rounded) balance means ALL of it, so the exact balance goes — no
  // dust, and no "1 > 0.995018" refusal of the figure the sheet itself showed.
  const typedSourceAmount =
    focus === "from" ? parsedAmount : (counterValue(parsedAmount, focus) ?? 0);
  const sourceAmount =
    focus === "from" && from
      ? moveSourceAmount({ typed: typedSourceAmount, available: from.available, whole: from.whole })
      : typedSourceAmount;
  const hasAmount = sourceAmount > 0;
  // Measured on the SOURCE side whichever side was typed in: the figure the
  // keypad holds may be the destination's, and it is the source balance that
  // has to cover the move. It reads the rail's spendable balance — settled,
  // too-fresh and preconfirmed alike — so a freshly settled wallet is no longer
  // reported as empty here, which is why this gate is safe to state again.
  // What the move actually SPENDS, which is not always what was typed: a
  // corridor that funds a lockup carries a fee on top, and its quote states
  // that figure. arkade → on-chain has no quote at all yet still runs over the
  // corridor above its floor, so the reservation is worked out in `moveSpend`
  // — the same headroom the send screen reserves for a Bitcoin recipient.
  const spendAmount = moveSpendAmount({
    sourceAmount,
    quotedSendAmount: swap.selectedQuote?.sendAmount,
    fromKey: from?.key,
    toKey: to?.key,
  });
  const overBalance = from?.available != null && spendAmount > from.available;
  // A source whose balance has not been read yet states no ceiling. That is not
  // "no limit": running a move against a figure nobody knows spends money the
  // rail may not hold, so the CTA waits for the read instead of guessing.
  const unknownBalance = from != null && from.available == null;
  const pairChosen = !!from && !!to && from.key !== to.key && pairOpen(from.key, to.key);
  // The pair's route bounds, known BEFORE any price: an amount below every
  // route's minimum (or above every maximum) says so on the button instead of
  // pricing a move nothing will take. Transfers and unknown bounds: no block.
  const priced =
    pairChosen && !!from?.asset && !!to?.asset && !(from?.sendSource && to?.sendSource);
  const bounds = useMoveSwapBounds({
    from: priced ? from?.asset : undefined,
    to: priced ? to?.asset : undefined,
    sendSource: from?.sendSource,
  });
  // A transfer has no quote, but arkade -> onchain still runs over the
  // corridor and carries its band.
  const boundBlock = swapBoundBlock(
    sourceAmount,
    priced ? bounds : moveTransferBounds(from?.key, to?.key),
  );
  // Prices are on the table: the keypad steps aside for them, and the button
  // means "run this one" instead of "price it".
  const quoting = swap.quotes !== null;

  // The price the CTA would run, and the same rows the shared route control
  // offers behind "Show more".
  const selectedQuote = swap.selectedQuote;
  const quoteDetail = selectedQuote
    ? [
        swapRouteCardDetail({
          path: selectedQuote.path,
          providers: selectedQuote.providers,
          etaSeconds: selectedQuote.etaSeconds,
        }),
        selectedQuote.executable ? null : t("swap.route.soon"),
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  const onRail = (value: number): string => (to ? railAmount(value, to.key) : "");

  // Once a price is in, the destination side of the card states THAT number.
  // The estimate it carried before is stale the moment a quote exists, and two
  // different figures for one move on one screen is just a puzzle to solve.
  const quotedTo = quoting && selectedQuote ? onRail(selectedQuote.receiveAmount) : null;

  const routeChoices = (swap.quotes ?? []).map((quote) => ({
    id: quote.id,
    label: onRail(quote.receiveAmount),
    sublabel: swapRouteCardDetail({
      path: quote.path,
      providers: quote.providers,
      etaSeconds: quote.etaSeconds,
    }),
    disabled: !quote.executable,
  }));

  // Snappy accept: confirming closes the sheet the same frame, and the transfer
  // runs detached — the same hand-off a priced swap gets, never a held busy
  // screen. A transfer is money leaving, so a failure is not swallowed: it
  // reopens the sheet and states it, the same pre-handoff-failure recovery the
  // swap path uses. "unhandled" (nothing ran) reopens without an error.
  const runTransfer = (retryAmount?: number) => {
    // The amount is captured BEFORE the sheet closes. `visible=false` clears
    // `amount`, so the re-rendered closure the try-again button calls would
    // otherwise read `sourceAmount === 0` and retry a zero transfer. Try again
    // replays the amount the user actually accepted.
    const amountToSend = retryAmount ?? sourceAmount;
    if (!(amountToSend > 0)) return;
    paymentTimingStart("move", { amount: amountToSend });
    setTransfer("idle");
    onClose();
    Promise.resolve(onConfirm(amountToSend))
      .then((outcome) => {
        if (outcome === "unhandled") onReopenOnFailure?.();
      })
      .catch((error: unknown) => {
        // Cancelling the passkey prompt is a deliberate choice, not a failure:
        // nothing was sent, so return to the amount the user was editing rather
        // than showing an error screen for their own Cancel.
        if (isUserCancelledAuth(error)) {
          setTransfer("idle");
          return;
        }
        const unresolved = isUnresolvedCommitOutcome(error);
        // Retained so the try-again button has the accepted figure to replay.
        setFailedTransferAmount(unresolved ? null : amountToSend);
        setTransfer(unresolved ? "unresolved" : "failed");
        // Never a raw error to the user: the failure view falls back to its own
        // human "Did not work, try again?" title. The technical detail goes to
        // support silently — the app's standard error-to-support pattern. A
        // caller that already reported this failure with its own, more
        // specific line is not reported twice.
        if (!wasReportedToSupport(error)) {
          void reportErrorToSupport({ error, userMessage: "Move transfer failed" }).catch(() => {});
        }
        // An unresolved outcome must not reopen a sheet whose only control is a
        // try-again: the money may already be committed. The overlay above owns
        // it and offers nothing to press.
        if (!unresolved) onReopenOnFailure?.();
      });
  };

  const next = () => {
    if (!from || !to || !pairChosen || !hasAmount || overBalance || unknownBalance || boundBlock)
      return;
    // No exchange, no price: the ends that no swap engine names are transfers,
    // and the caller moves those. The two bitcoin wallets share ONE asset, so
    // they are a transfer too — the caller offboards/onboards, there is no
    // route to price.
    const btcToBtc = Boolean(from.sendSource && to.sendSource);
    if (!from.asset || !to.asset || btcToBtc) {
      runTransfer();
      return;
    }
    void swap.requestQuotes({
      from: from.asset,
      to: to.asset,
      amount: sourceAmount,
      ...(from.sendSource ? { sendSource: from.sendSource } : {}),
      ...(to.settleAddress ? { settleTarget: to.settleAddress } : {}),
      ...(to.settleKind ? { destination: to.settleKind } : {}),
    });
  };

  // A named bound replaces the generic line: "Minimum 10 000 sats" tells the
  // user what to change, "No route right now" does not.
  const ctaLabel = swap.noRoute
    ? swap.noRouteReason || t("screen.MoveSheet.noRoute")
    : quoting
      ? t("screen.MoveSheet.confirm")
      : from && to && !pairOpen(from.key, to.key)
        ? t("screen.MoveSheet.pairUnavailable", { from: from.label, to: to.label })
        : boundBlock && from
          ? t(boundBlock.kind === "min" ? "swap.cta.minimum" : "swap.cta.maximum", {
              value: railAmount(boundBlock.value, from.key),
            })
          : overBalance
            ? t("screen.SepaAmountConfirmationModal.insufficientHint")
            : t("screen.MoveSheet.next");
  const ctaDisabled =
    !pairChosen ||
    !hasAmount ||
    unknownBalance ||
    // The message beside a live button is a button that does nothing: `next()`
    // returns immediately on an over-balance amount, so the CTA has to say so.
    overBalance ||
    (boundBlock !== null && !quoting) ||
    swap.noRoute ||
    (quoting && !swap.selectedQuote?.executable);

  // The wait and the failure are the app's own swap screens, so a move looks
  // like every other swap while it runs. The failure wins over the wait: a
  // retry re-prices behind this screen and must not flash the wait back up.
  const overlay =
    transfer === "failed" || transfer === "unresolved" ? (
      // An unresolved withdrawal keeps the screen but never the button: the
      // funds may already have moved, so there is nothing safe to press.
      <SwapTryAgainView
        onRetry={() => runTransfer(failedTransferAmount ?? undefined)}
        retrying={transfer === "unresolved"}
        {...(transfer === "unresolved"
          ? { title: t("screen.WirexSendChoice.withdrawUnconfirmed") }
          : {})}
      />
    ) : swap.failed ? (
      <SwapTryAgainView onRetry={swap.retry} retrying={swap.busy !== null} />
    ) : swap.busy ? (
      <SwapProcessingView phase="route" />
    ) : null;

  // A half is its own CARD, and the whole card is ONE press area: tapping
  // anywhere in it starts expressing the move in that side's currency. Only the
  // trigger escapes, because it opens that side's account picker — which is why
  // it is held in a row that hugs it instead of stretching across the card.
  const half = (side: Side) => {
    const rail = side === "from" ? from : to;
    const focused = focus === side;
    const availableAmount =
      side === "from" && rail?.available != null
        ? railAmount(rail.available, rail.key).replace(/^\S+\s+/, "")
        : undefined;
    // A fixed end is stated, not offered: the same line the pay page shows
    // for its recipient.
    const trigger =
      locked === side ? (
        <View direction="row" align="center" gap="sm">
          <Text size="md" muted>
            {side === "from" ? t("screen.MoveSheet.from") : t("screen.MoveSheet.to")}
          </Text>
          <Text size="md">
            {`${rail?.label ?? ""}${side === "from" && availableAmount ? ` (${availableAmount})` : ""}`}
          </Text>
        </View>
      ) : (
        <View direction="row" align="center">
          <RailTrigger
            rail={rail}
            side={side}
            availableAmount={availableAmount}
            onPress={() => setPicking(side)}
          />
        </View>
      );
    const focusLabel = t("screen.MoveSheet.focusA11yLabel", { rail: rail?.label ?? side });

    // The collapsed half is an intrinsic strip — one `xl` row: the trigger, and
    // the same amount expressed on its own side stated small beside it.
    if (!focused) {
      return (
        <Pressable
          chrome="subtle"
          radius="lg"
          paddingX="lg"
          height="xl"
          justify="center"
          onPress={() => focusSide(side)}
          accessibilityLabel={focusLabel}
        >
          <View direction="row" justify="between" align="center">
            {trigger}
            <Text size="md" emphasis>
              {side === "to" && quotedTo ? quotedTo : counter}
            </Text>
          </View>
        </Pressable>
      );
    }

    // The focused half takes every point the keypad and the buttons leave, and
    // carries the figure at its bottom-right.
    return (
      <Pressable
        chrome="subtle"
        radius="lg"
        paddingX="lg"
        paddingY="md"
        direction="column"
        align="stretch"
        fill="grow"
        onPress={() => focusSide(side)}
        accessibilityLabel={focusLabel}
      >
        {trigger}
        {/* The ceiling is NOT in here: it is the row under both cards, which
            states it once and carries the Max that fills it in. */}
        <View fill="grow" justify="end" align="end">
          <Text size="3xl" align="end">
            {side === "to" && quotedTo ? quotedTo : figure}
          </Text>
        </View>
      </Pressable>
    );
  };

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      {overlay ? (
        <>
          {/* The wait and the failure have no Cancel row of their own, so THEY
              keep a way out: the page's own close, like every other page. The
              board does not: its Cancel button is the way out. */}
          <Header safeAreaTop chrome="canvas">
            <Topbar surface="transparent">
              <TopbarTrailing>
                <IconButton
                  icon="cross"
                  variant="soft"
                  accessibilityLabel={t("common.close")}
                  onPress={onClose}
                />
              </TopbarTrailing>
            </Topbar>
          </Header>
          <Scroll safeAreaBottom>
            <View direction="column" align="stretch" fill="grow">
              {overlay}
            </View>
          </Scroll>
        </>
      ) : (
        <>
          {/* No scroll on this screen: the keypad and the buttons are docked and
              the pair of cards takes exactly the height they leave, so there is
              never anything below the fold to reach. This band is the safe area
              alone — the sheet's only chrome. */}
          <Header safeAreaTop />
          <View direction="column" align="stretch" fill="grow" gap="lg" paddingX="lg" paddingY="lg">
            <View direction="column" align="stretch" gap="xs" fill="grow">
              {/* The seam: ONE dark scope over both cards and the control
                  between them — and NOTHING else, because the ghost alert below
                  paints on the panel it actually sits on, and inside the dark
                  scope it would be light on light. The scope is context only, so
                  the cards and the band stay direct children of this stack and
                  the seam arithmetic is untouched: the zero-flow-height Bleed
                  band rides the card boundary, so the parent gap fires twice
                  around it — the seam is 2 × `xs`. */}
              <NuriScope mode="dark">
                <Fragment>
                  {half("from")}
                  <Bleed top="xl" bottom="xl">
                    <View direction="row" justify="center" align="center" height="lg">
                      <IconButton
                        icon="arrow-down"
                        variant="solid"
                        disabled={locked !== null}
                        accessibilityLabel={t("screen.MoveSheet.flipA11yLabel")}
                        onPress={flip}
                      />
                    </View>
                  </Bleed>
                  {half("to")}
                </Fragment>
              </NuriScope>
            </View>
          </View>

          {/* The footer adds the safe-area inset on top of its padding. On a
              phone without a home indicator that inset is 0 and "sm" left the
              buttons on the screen edge, so it gets "lg" there instead. */}
          <Footer
            safeAreaBottom
            direction="column"
            align="stretch"
            gap="sm"
            paddingX="lg"
            paddingBottom={insets.bottom > 0 ? "sm" : "lg"}
          >
            {/* ONE box under the cards, whatever it holds. The keypad sizes it
                and the price takes at least that height, so the card above keeps
                the size it had while the amount was typed — a control that grows
                when the prices arrive reads as a different screen. A FLOOR, not
                a cap: "Show more" opens as many routes as the quote returned,
                and a fixed height would push the last of them, and the way back,
                under the buttons.
                No amount chips: on a short screen they cost a whole row, and the
                keypad already types every amount they offered. */}
            <RNView
              style={keypadHeight > 0 ? { minHeight: keypadHeight } : undefined}
              onLayout={
                quoting
                  ? undefined
                  : (event) => setKeypadHeight(Math.round(event.nativeEvent.layout.height))
              }
            >
              {quoting ? (
                // The accepted price on its own, the alternatives behind "Show
                // more" — the way every other swap screen presents one. The
                // figure itself is in the card, on the destination side; what is
                // here is who fills it and the way into the others.
                <View direction="column" align="stretch" justify="center" gap="sm" fill="grow">
                  {quoteDetail ? (
                    <Text size="md" muted align="center">
                      {quoteDetail}
                    </Text>
                  ) : null}
                  <SwapRouteChoices
                    options={routeChoices}
                    selectedId={swap.selectedId}
                    onSelect={swap.selectQuote}
                  />
                </View>
              ) : (
                <AmountKeypad
                  onDigit={(digit) => changeAmount(`${amount}${digit}`)}
                  onDecimal={() => changeAmount(`${amount}.`)}
                  onDelete={() => changeAmount(amount.slice(0, -1))}
                />
              )}
            </RNView>
            {/* Cancel is the way out of this sheet — there is no close button
                over the cards. */}
            <View direction="row" distribute="even" gap="sm">
              <Button size="lg" variant="soft" onPress={onClose}>
                <ButtonText>{t("common.cancel")}</ButtonText>
              </Button>
              <Button
                size="lg"
                variant="solid"
                accent="lilac"
                disabled={ctaDisabled}
                onPress={() => {
                  if (!quoting) {
                    next();
                    return;
                  }
                  // Accepting is the last thing the user does. Close the sheet
                  // THIS frame so the tap feels instant; confirm() runs detached
                  // — the commit and the global move pill own everything after
                  // the handoff, and a pre-commit failure (nothing moved)
                  // reopens the sheet via onReopenOnFailure.
                  void swap.confirm();
                  onClose();
                }}
              >
                <ButtonText>{ctaLabel}</ButtonText>
              </Button>
            </View>
          </Footer>
        </>
      )}

      {/* The source/destination pickers are full-screen so their DS Scroll has a
          bounded viewport on web. In the destination picker the source is disabled so a pair cannot collapse. */}
      <ChoiceSheet
        visible={picking !== null}
        onClose={() => setPicking(null)}
        mode="full"
        title={
          picking === "from"
            ? t("screen.MoveSheet.pickerFromTitle")
            : t("screen.MoveSheet.pickerToTitle")
        }
        items={rails.map((rail) => {
          const other = rails.find((r) => r.key === (picking === "from" ? toKey : fromKey));
          const open = picking ? pairOpenFor(picking, rail.key) : true;
          return {
            key: rail.key,
            label: rail.label,
            // An unavailable destination states WHY, where the balance would be.
            sublabel:
              open || !other
                ? rail.amount
                : t("screen.MoveSheet.pairUnavailable", { from: other.label, to: rail.label }),
            image: rail.image,
            // Every source is pickable (the destination follows it); only a
            // destination the source cannot reach, or the source itself, is not.
            disabled:
              (picking === "to" && (rail.key === other?.key || !open)) ||
              // With the destination fixed, a source is offered only when it
              // can reach it.
              (picking === "from" &&
                locked === "to" &&
                (rail.key === toKey || !toKey || !pairOpen(rail.key, toKey))),
          };
        })}
        onSelect={(key) => {
          const unreachable =
            picking === "from" &&
            locked === "to" &&
            (key === toKey || !toKey || !pairOpen(key, toKey));
          if (picking && picking !== locked && !unreachable && pairOpenFor(picking, key)) {
            pickRail(picking, key);
          }
          setPicking(null);
        }}
      />
    </DsSheetHost>
  );
};

export default MoveSheet;
