import { type ReactNode, useState } from "react";
import { useWindowDimensions, View as RNView } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { useNuriTheme, View } from "@ds";

/**
 * AddressQrTile — the DS QR presentation from the share-address / lightning-
 * address sheet layouts: an outline card with the QR centered on the sheet
 * background. The QR modules take the theme's canvas foreground (ink) color;
 * the card's padding is the quiet zone. The QR fills the measured inner width,
 * so the tile stays square on every screen size.
 *
 * ponytail / DS deviation: the tile is capped to ~42% of the viewport height so
 * short screens never have to scroll the sheet — it just shrinks. This height
 * cap is a plain RN maxWidth wrapper, not a DS primitive; flag for the DS owner
 * to fold into a DS sizing token.
 */
export default function AddressQrTile({
  value,
  header,
  children,
}: { value: string; header?: ReactNode; children?: ReactNode }) {
  const theme = useNuriTheme();
  const { height } = useWindowDimensions();
  const [side, setSide] = useState(0);
  const maxSide = Math.round(height * 0.42);
  return (
    <RNView style={{ alignSelf: "center", maxWidth: maxSide, width: "100%" }}>
      {header ? <View paddingBottom="sm">{header}</View> : null}
      <View variant="outline" radius="lg" padding="xl">
        <View
          aspectRatio="square"
          align="center"
          justify="center"
          onLayout={(event) => setSide(Math.round(event.nativeEvent.layout.width))}
        >
          {side > 0 ? (
            <QRCode
              value={value}
              size={side}
              color={theme.chrome.canvas.fg}
              backgroundColor="transparent"
            />
          ) : null}
        </View>
      </View>
      {children ? <View paddingTop="sm">{children}</View> : null}
    </RNView>
  );
}
