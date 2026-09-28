import type { FC } from "react";
import { Button, ButtonText, Text, View } from "@ds";
import BlockchainIllustration from "../assets/illustrations/blockchain.svg";
import CheckRouteIllustration from "../assets/illustrations/checkroute.svg";
import ErrorTryAgainIllustration from "../assets/illustrations/error-tryagain.svg";
import { t } from "../lib/i18n";
import BrandStatusView from "./BrandStatusView";
import PopRiffleView from "./PopRiffleView";

// "transfer" is the same wait without an exchange in it — the money is going
// straight to an address, so calling it a swap describes something that is not
// happening.
//
// There is deliberately no post-acceptance phase. Accepting a quote is the last
// thing the user does: the sheet closes on the handoff and the global move
// status pill carries the rest. A "blockchain swap processing" screen after the
// signature held the user on a screen that could only wait.
export type SwapProcessingPhase = "route" | "transfer";

type Props = {
  phase: SwapProcessingPhase;
  /** Live status from the services/tracker, shown as the muted line under the
   * title. Absent until something real happens — no static stand-in, or it just
   * restates the title. */
  statusText?: string | null;
};

// Fullscreen wait state for swaps, on the shared brand scaffold: the phase title
// as the brand display headline, the live status as the muted line beneath it,
// animated brand illustration centered. No CTA — nothing here is tappable, so
// nothing here looks tappable. Rendered INSIDE the swap sheet's layer so
// passkey/biometric overlays still stack above it.
const SwapProcessingView: FC<Props> = ({ phase, statusText }) => {
  const Illustration = phase === "route" ? CheckRouteIllustration : BlockchainIllustration;
  return (
    <BrandStatusView
      title={t(phase === "route" ? "swap.processing.routeTitle" : "swap.processing.transferTitle")}
      caption={statusText}
      illustration={<Illustration width={240} height={240} />}
    />
  );
};

// Honest failure state: "Didn't work, try again?" with ONE button that takes the
// user back to the point that makes sense (a fresh route list). Never a raw
// error message.
// `inline` is the embedded use (card-details reveal error), where the sheet
// already owns the screen and a 40px display headline would shout — it keeps the
// compact headline. Fullscreen hosts get the shared brand scaffold.
export const SwapTryAgainView: FC<{
  onRetry: () => void;
  retrying?: boolean;
  inline?: boolean;
  /**
   * Overrides the headline for a failure that is NOT "didn't work": an outcome
   * nobody can confirm yet has to say so, or the user reads a locked button as
   * a broken screen and looks for another way to send the same money.
   */
  title?: string;
}> = ({ onRetry, retrying = false, inline = false, title }) => {
  const retryButton = (
    <Button size="lg" variant="solid" accent="lilac" disabled={retrying} onPress={onRetry}>
      <ButtonText>{t("swap.fail.retry")}</ButtonText>
    </Button>
  );

  if (!inline) {
    return (
      <BrandStatusView
        title={title ?? t("swap.fail.title")}
        illustration={<ErrorTryAgainIllustration width={156} height={285} />}
        footer={retryButton}
      />
    );
  }

  return (
    <View
      direction="column"
      align="stretch"
      justify="between"
      gap="lg"
      paddingX="lg"
      paddingBottom="lg"
      fill="grow"
    >
      <Text size="lg" emphasis>
        {title ?? t("swap.fail.title")}
      </Text>
      <View direction="column" align="center" justify="center" fill="grow">
        <PopRiffleView active>
          <ErrorTryAgainIllustration width={156} height={285} />
        </PopRiffleView>
      </View>
      {retryButton}
    </View>
  );
};

export default SwapProcessingView;
