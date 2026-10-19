// @screen app.v2-move-status
import * as React from "react";

import { Alert, AlertButton, AlertIcon, IconButton, Text, useToast } from "@ds";
import { Animated, Easing, View as RNView, type ViewStyle } from "react-native";

import { COMPACT_AFTER_MS, PILL_MORPH_MS, fullPillScaleAtCompact } from "./movePillGeometry";

import { t } from "../lib/i18n";
import { hasOpenSurface, subscribeOpenSurfaces } from "../lib/ui/openSurfaces";
import SwapStatusDetailSheet from "../screens/swapkit/SwapStatusDetailSheet";
import {
  dismissV2Move,
  forgetV2Move,
  isTerminalMovePhase,
  resolveV2MoveId,
  subscribeV2Moves,
  type SwapKitV2Move,
} from "../services/swapkit/SwapKitV2MoveStatus";
import { resumeSwapKitV2Order } from "../services/swapkit/SwapKitV2PendingTracker";
import { movePillSignature, v2MoveLabel } from "./v2MoveLabel";

/**
 * V2MoveStatusBridge — the app-level status pill for SwapKit v2 moves.
 *
 * Accepting a quote is the last thing the user does: the sheet closes on the
 * handoff and the move finishes without a screen. This is where it then lives.
 * It names the step the wallet is actually on (Approving… / Executing…), never
 * a timer, and only offers a tap when the move genuinely needs one — everything
 * the wallet can run unattended it runs, and the pill just reports it.
 *
 * Same two mounting rules as OtaUpdateToastBridge: shown once, and never over an
 * open sheet — a status bubble on top of a signing surface competes with the
 * thing the user is trying to do. Dismissal hides the presentation only;
 * tracking, recovery and the balance accounting are untouched by it.
 *
 * Mounted once inside DsOverlayRoot, within ToastProvider.
 */
export default function V2MoveStatusBridge(): React.ReactElement | null {
  const toast = useToast();
  const [moves, setMoves] = React.useState<readonly SwapKitV2Move[]>([]);
  const [detailOrderId, setDetailOrderId] = React.useState<string | null>(null);
  // What is currently on screen, so an unchanged store publication does not
  // re-show a pill the user just dismissed.
  const shownRef = React.useRef<string>("");

  React.useEffect(() => subscribeV2Moves(setMoves), []);

  // The move the pill speaks for: anything needing the user first (that is the
  // only actionable state), otherwise the most recently updated live move.
  const visible = React.useMemo(() => {
    const live = moves.filter((move) => !move.dismissed);
    return (
      live.find((move) => move.phase === "action_required") ??
      live.find((move) => !isTerminalMovePhase(move.phase)) ??
      live[live.length - 1] ??
      null
    );
  }, [moves]);

  const othersRunning = React.useMemo(
    () =>
      moves.filter((move) => !isTerminalMovePhase(move.phase) && move.orderId !== visible?.orderId)
        .length,
    [moves, visible],
  );

  React.useEffect(() => {
    if (!visible) {
      shownRef.current = "";
      return;
    }
    const signature = movePillSignature(visible, othersRunning);
    const offer = () => {
      // A signing/confirmation surface owns the screen while it is open.
      if (hasOpenSurface() || shownRef.current === signature) return;
      shownRef.current = signature;
      const orderId = visible.orderId;
      const terminal = isTerminalMovePhase(visible.phase);
      const needsUser = visible.phase === "action_required";
      toast.show(
        <MovePill
          key={signature}
          move={visible}
          // A running move sits over the home for as long as Bitcoin takes to
          // confirm, so it folds down to its icon. Anything asking for the user
          // or reporting an outcome stays full.
          compactable={!terminal && !needsUser && visible.phase !== "preparing"}
          onPress={
            // A wallet↔card transfer has no order behind it to open.
            visible.kind === "transfer"
              ? undefined
              : () => {
                  // Acting on a move is also acknowledging it: this is the one
                  // place a pill stops speaking for an order without its phase
                  // changing.
                  dismissV2Move(orderId);
                  if (needsUser) {
                    // Re-arm the stopped loop with this order's own persisted
                    // bounds. It can refuse (another loop got there first, the
                    // order is not this wallet's, the bounds are gone) — the
                    // detail sheet is then the honest answer, never a silently
                    // dead button.
                    void resumeSwapKitV2Order(orderId).catch(() => {
                      setDetailOrderId(orderId);
                    });
                    return;
                  }
                  setDetailOrderId(orderId);
                }
          }
        />,
        // A finished move reports itself and goes; anything still running stays
        // until it changes — a status the user scrolled past is a status they
        // never had.
        terminal ? { duration: 6000 } : { duration: null },
      );
      if (terminal) {
        // The outcome has been shown; the pill has nothing left to say about it.
        const settledId = orderId;
        setTimeout(() => forgetV2Move(settledId), 6000);
      }
      // A non-terminal move is deliberately NOT dismissed here. The toast layer
      // is replace-not-queue, so a copy toast, an OTA offer or another move's
      // pill can take this one off screen at any moment; marking it dismissed
      // for having been shown once would hide it for the rest of the session —
      // and an action_required move, which may never change phase by itself,
      // would lose its only CTA. `shownRef` already prevents re-showing the
      // same state; a surface closing re-offers it.
    };
    offer();
    return subscribeOpenSurfaces(() => offer());
  }, [visible, othersRunning, toast]);

  if (!detailOrderId) return null;
  // A pill opened while the swap still had its provisional id follows the real
  // order as soon as the server names it (`moves` re-renders this on that).
  return (
    <SwapStatusDetailSheet
      visible
      orderId={resolveV2MoveId(detailOrderId)}
      onClose={() => setDetailOrderId(null)}
    />
  );
}

/**
 * The pill. A running move folds down to its icon after a while and opens
 * again on a tap; a new phase is a new pill (keyed by it), so every status
 * change arrives full size.
 *
 * Compact, the pill is the DS IconButton — the very circle the close button
 * is (48², radius full, glyph centred by the DS) — never a clipped or scaled
 * copy of the wide pill, which is what came out oval. The full pill and the
 * circle sit in one centred stack and cross-fade while the full one scales
 * down to the circle's height (Animated, both ways; a LayoutAnimation does
 * nothing inside the DS toast overlay).
 */
function MovePill({
  move,
  compactable,
  onPress,
}: {
  move: SwapKitV2Move;
  compactable: boolean;
  onPress?: () => void;
}): React.ReactElement {
  const [compact, setCompact] = React.useState(false);
  const [fullHeight, setFullHeight] = React.useState(0);
  const progress = React.useRef(new Animated.Value(0)).current;
  const needsUser = move.phase === "action_required";

  React.useEffect(() => {
    if (!compactable || compact) return;
    const timer = setTimeout(() => setCompact(true), COMPACT_AFTER_MS);
    return () => clearTimeout(timer);
  }, [compactable, compact]);

  React.useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: compact ? 1 : 0,
      duration: PILL_MORPH_MS,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [compact, progress]);

  // Orange = went wrong / needs you; lilac = the app must stay open while the
  // wallet has not paid yet; neutral = running on its own.
  const accent =
    needsUser || move.phase === "failed"
      ? "orange"
      : move.phase === "preparing"
        ? "lilac"
        : "neutral";
  const icon =
    move.phase === "completed"
      ? "check-circle"
      : needsUser || move.phase === "failed"
        ? "warning-circle"
        : "spinner";

  const fullStyle = {
    opacity: progress.interpolate({
      inputRange: [0, 0.6],
      outputRange: [1, 0],
      extrapolate: "clamp",
    }),
    transform: [
      {
        scale: progress.interpolate({
          inputRange: [0, 1],
          outputRange: [1, fullPillScaleAtCompact(fullHeight)],
        }),
      },
    ],
  } as Animated.WithAnimatedObject<ViewStyle>;
  const circleStyle = {
    position: "absolute" as const,
    opacity: progress.interpolate({
      inputRange: [0.4, 1],
      outputRange: [0, 1],
      extrapolate: "clamp",
    }),
    transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
  } as Animated.WithAnimatedObject<ViewStyle>;

  return (
    <RNView style={{ alignItems: "center", justifyContent: "center" }}>
      <Animated.View
        style={fullStyle}
        pointerEvents={compact ? "none" : "auto"}
        onLayout={(event) => setFullHeight(event.nativeEvent.layout.height)}
      >
        <Alert variant="soft" accent={accent}>
          <AlertIcon name={icon} />
          {/* Fixed-width label so the pill does not resize (and the toast does
              not recenter) as the wording changes between Approving… /
              Executing… / Completed. */}
          <RNView style={{ minWidth: 132 }}>
            <Text size="md" muted>
              {v2MoveLabel(move)}
            </Text>
          </RNView>
          {onPress ? (
            <AlertButton
              accessibilityLabel={
                needsUser ? t("swap.move.actionRequiredAction") : t("swap.move.view")
              }
              onPress={onPress}
            >
              {needsUser ? t("swap.move.actionRequiredAction") : t("swap.move.view")}
            </AlertButton>
          ) : null}
        </Alert>
      </Animated.View>
      <Animated.View style={circleStyle} pointerEvents={compact ? "auto" : "none"}>
        <IconButton
          icon={icon}
          variant="soft"
          accent={accent}
          accessibilityLabel={v2MoveLabel(move)}
          onPress={() => setCompact(false)}
        />
      </Animated.View>
    </RNView>
  );
}
