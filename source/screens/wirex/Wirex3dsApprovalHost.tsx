// screens/wirex/Wirex3dsApprovalHost.tsx
// The pending in-app 3DS challenge poll plus its approval view, as one thing to
// mount. A pending challenge is a real payment the user is standing in front of
// — it has to be answerable from wherever the app happens to be, so the poll
// belongs to the app rather than to whichever screen shows the card. Mount this
// EXACTLY ONCE: a second copy would poll and respond in parallel.
//
// It reads the wallet from the account snapshot itself, so it takes no props,
// and it dismisses on `ui:resetMainScreens` like the screens do — the hook
// re-polls on foreground and on `card:refresh` (which a tapped 3DS push emits),
// so a dismissed-but-still-pending challenge comes straight back.
// SECURITY: renders merchant/amount only; nothing here is logged.
import type React from "react";
import { useEffect } from "react";
import { EventBus } from "../../services/events/AppEventBusService";
import { useWirexCard } from "./hooks/useWirexCard";
import { useWirex3dsChallenges } from "./hooks/useWirex3dsChallenges";
import Wirex3dsApprovalModal from "./modals/Wirex3dsApprovalModal";

const Wirex3dsApprovalHost: React.FC = () => {
  const { wallet, card } = useWirexCard();
  const threeDs = useWirex3dsChallenges({ wallet, enabled: Boolean(card?.id) });

  // `dismiss` is referentially stable, so the subscription won't churn.
  useEffect(() => EventBus.on("ui:resetMainScreens", threeDs.dismiss), [threeDs.dismiss]);

  return (
    <Wirex3dsApprovalModal
      visible={threeDs.visible}
      challenge={threeDs.challenge}
      busy={threeDs.responding}
      onApprove={() => threeDs.respond(true)}
      onDecline={() => threeDs.respond(false)}
      onClose={threeDs.dismiss}
    />
  );
};

export default Wirex3dsApprovalHost;
