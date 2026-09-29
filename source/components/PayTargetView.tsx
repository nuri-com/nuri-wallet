// @component pay-target
// Short recipient above QR; one copy hint below. Clipboard retains the complete payment URI.
import type React from "react";
import { Pressable, Text, View } from "@ds";
import AddressQrTile from "./AddressQrTile";
import PayWalletButtons from "./PayWalletButtons";
import { copyToClipboard } from "../lib/copyToClipboard";
import { t } from "../lib/i18n";
import { shortAddress } from "../lib/formatting";
import type { PayTarget } from "../lib/pay/payTarget";

type Props = {
  target: PayTarget;
  label: string;
  /** Exact amount from the target, never the pre-quote input. */
  exactAmount?: string;
  status?: string;
};

const PayTargetView: React.FC<Props> = ({ target, label, exactAmount, status }) => (
  <View direction="column" align="stretch" gap="sm">
    {/* Copy exactly what the QR encodes, including its network/token/amount. */}
    <Pressable
      onPress={() => void copyToClipboard(target.uri)}
      accessibilityLabel={[t("common.copy"), label, exactAmount].filter(Boolean).join(": ")}
    >
      <AddressQrTile
        value={target.uri}
        header={
          <View paddingX="xl">
            <Text
              size="sm"
              muted
              mono
              align="center"
              flow="truncate"
              lines={1}
              accessibilityLabel={target.value}
            >
              {shortAddress(target.value)}
            </Text>
          </View>
        }
      >
        <Text size="sm" muted align="center" flow="truncate" lines={1}>
          {t("screen.PayLink.copyTarget")}
        </Text>
      </AddressQrTile>
    </Pressable>
    <PayWalletButtons key={target.uri} target={target} />
    {status ? (
      <Text size="sm" muted align="center">
        {status}
      </Text>
    ) : null}
  </View>
);

export default PayTargetView;
