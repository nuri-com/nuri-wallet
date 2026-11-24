import type { FC } from "react";
import BlockchainIllustration from "../assets/illustrations/blockchain.svg";
import CheckRouteIllustration from "../assets/illustrations/checkroute.svg";
import { t } from "../lib/i18n";
import BrandStatusView from "./BrandStatusView";

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

export default SwapProcessingView;
