import { useEffect, useState } from "react";
import {
  getArkadeLnurlStatus,
  getArkadeLnurlStatusPersisted,
} from "../../services/arkade/ArkadeLnurlService";
import type { ArkadeInvitee } from "../../services/arkade/types/lnurl";

/**
 * The users the signed-in user invited, while Settings is open: the saved
 * account status first, then a fresh read that never prompts for a passkey
 * (without a recent login it answers the saved status again).
 */
export function useInvitees(visible: boolean): ArkadeInvitee[] {
  const [invitees, setInvitees] = useState<ArkadeInvitee[]>([]);
  useEffect(() => {
    if (!visible) {
      setInvitees([]);
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      const saved = await getArkadeLnurlStatusPersisted().catch((): null => null);
      if (!cancelled && saved) setInvitees(saved.invitees ?? []);
      const live = await getArkadeLnurlStatus(undefined, {
        allowPrompt: false,
        reason: "settings_invitees",
      }).catch((): null => null);
      if (!cancelled && live?.registered) setInvitees(live.invitees ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);
  return invitees;
}
