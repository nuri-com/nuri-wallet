import type React from "react";
import NostrChatModal from "./NostrChatModal";
import type { PasskeyWebAuthnPrfCreateResult } from "./PasskeyWebAuthnPrfView";
import type { NostrKeypair } from "../lib/nostr/nostr";
import { SUPPORT_PUBKEY } from "../lib/nostr/unread";

type Props = {
  showNostrChat: boolean;
  onCloseNostrChat: () => void;
  autoSendMessage?: string;
  prefillMessage?: string;
  keypairOverride?: NostrKeypair;
  onCreatePasskey?: (result: PasskeyWebAuthnPrfCreateResult) => void;
  showV1MigrationLink?: boolean;
};

const SupportModals: React.FC<Props> = ({
  showNostrChat,
  onCloseNostrChat,
  autoSendMessage,
  prefillMessage,
  keypairOverride,
  onCreatePasskey,
  showV1MigrationLink,
}) => (
  <NostrChatModal
    visible={showNostrChat}
    onClose={onCloseNostrChat}
    supportPubkey={SUPPORT_PUBKEY}
    autoSendMessage={autoSendMessage}
    prefillMessage={prefillMessage}
    keypairOverride={keypairOverride}
    onCreatePasskey={onCreatePasskey}
    showV1MigrationLink={showV1MigrationLink}
  />
);

export default SupportModals;
