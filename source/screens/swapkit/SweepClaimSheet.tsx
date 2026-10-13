import type { FC } from "react";
import { useState } from "react";
import { StyleSheet, View as RNView } from "react-native";

import { Button, ButtonText, Footer, Header, IconButton, Topbar, TopbarTrailing } from "@ds";

import GeldsackIllustration from "../../assets/illustrations/geldsack.svg";
import BrandStatusView from "../../components/BrandStatusView";
import DsSheetHost from "../../components/DsSheetHost";
import { t } from "../../lib/i18n";
import { claimSwapKitSweep } from "../../services/swapkit/SwapKitV2SweepService";
import type { SwapKitV2SweepResult } from "../../services/swapkit/SwapKitV2SweepService";

/**
 * Fullscreen "we found money of yours!" claim sheet (swap_sweep) on the shared
 * BrandStatusView scaffold: brand display headline, the found amount under it,
 * animated brand illustration centered, one CTA in the footer.
 *
 * One tap arms the sweep and the screen closes as soon as the first order is
 * adopted — the claim is the user's whole part in it. Each conversion then runs
 * as a normal tracked swap: the global move-status pill names the step it is on
 * and the pending rows carry it, exactly as an ordinary move does. Holding this
 * screen until every order settled was a wait with nothing in it.
 */

type Props = {
  visible: boolean;
  onClose: () => void;
  result: SwapKitV2SweepResult | null;
};

const formatUsd = (value: unknown): string => {
  const usd = Number(value);
  return Number.isFinite(usd) && usd > 0 ? `~USD ${usd.toFixed(2)}` : "";
};

const SweepClaimSheet: FC<Props> = ({ visible, onClose, result }) => {
  const [busy, setBusy] = useState(false);

  const claim = async () => {
    if (busy) return;
    setBusy(true);
    // The first adopted order closes this screen; the rest of the run continues
    // without it. Guarded so a later outcome branch cannot close a second time.
    let closed = false;
    const handOff = () => {
      if (closed) return;
      closed = true;
      setBusy(false);
      onClose();
    };
    try {
      // No success callback: `started` counts transfers SUBMITTED, not swaps
      // completed. The conversion runs afterwards and the pending rows carry it.
      const { started, refusedLocally, unresolved, refunded } = await claimSwapKitSweep(handOff);
      if (closed) return;
      // Stay open only when the run is a SETTLED refusal: nothing started, this
      // app said no, and nothing was left hanging. That verdict repeats on every
      // later scan, so closing would report success over money that never moved
      // and then re-offer the same balance forever. The button returns to idle;
      // no error text, per the flow spec.
      //
      // A single unresolved item disqualifies that: an item the server could not
      // arm, or a funding transfer whose outcome is unknown, may well succeed
      // next time, and a mixed run must not be held open on the strength of the
      // one balance that was refused. Those close, like a throw does, and the
      // normal rescan re-offers whatever is still there.
      if (started <= 0 && refunded <= 0 && refusedLocally > 0 && unresolved === 0) {
        console.log(`[SweepClaim] ${refusedLocally} balance(s) refused locally — sheet stays open`);
        return;
      }
      handOff();
    } catch (e) {
      // No error surfaces here (flow spec): detection re-offers on the next
      // check; the sheet just closes calmly.
      console.log(`[SweepClaim] arm failed: ${e instanceof Error ? e.message : String(e)}`);
      handOff();
    } finally {
      if (!closed) setBusy(false);
    }
  };

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        {/* Trailing-only topbar (no title row) — the same markup the success
            screens use; the headline lives in the body. */}
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

      {/* The screen never scrolls — BrandStatusView shrinks the illustration to
          the height the header and footer leave over. */}
      <RNView style={styles.body}>
        <BrandStatusView
          title={t("screen.SweepClaimSheet.title")}
          amount={formatUsd(result?.totalUsd)}
          illustration={<GeldsackIllustration width={240} height={219} />}
        />
      </RNView>

      <Footer safeAreaBottom direction="column" align="stretch" paddingBottom="sm" paddingX="lg">
        <Button
          size="lg"
          variant="solid"
          accent="lilac"
          disabled={busy}
          onPress={() => {
            void claim();
          }}
          accessibilityLabel={t("screen.SweepClaimSheet.cta")}
        >
          <ButtonText>
            {busy ? t("screen.SweepClaimSheet.claiming") : t("screen.SweepClaimSheet.cta")}
          </ButtonText>
        </Button>
      </Footer>
    </DsSheetHost>
  );
};

const styles = StyleSheet.create({
  body: {
    flex: 1,
    minHeight: 0,
  },
});

export default SweepClaimSheet;
