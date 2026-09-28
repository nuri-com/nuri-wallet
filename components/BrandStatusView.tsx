import { type FC, type ReactNode, cloneElement, isValidElement, useState } from "react";
import { View as RNView } from "react-native";
import { Text, View } from "@ds";
import BrandDisplayTitle from "./BrandDisplayTitle";
import PopRiffleView from "./PopRiffleView";

/**
 * The body of every fullscreen brand status screen — waiting, found money,
 * didn't-work. One scaffold so they stop drifting apart: brand display title,
 * an optional value line, an optional muted line, the animated brand
 * illustration centered, and whatever the state's CTA is at the bottom.
 *
 * The title lives HERE, not in the host Topbar: the topbar keeps only the close
 * button, which is what the success screens already do. These screens never
 * scroll: the illustration gives up its space instead (see below).
 */

type Props = {
  title: string;
  /** Prominent value under the title — amounts. */
  amount?: string | null;
  /** Muted line under the title — live status, hints. */
  caption?: string | null;
  /** Brand asset at its intended size. Shrunk to fit on short screens. */
  illustration: ReactNode;
  /** Bottom slot: the CTA, for states that have one. */
  footer?: ReactNode;
};

type SizedProps = { width?: number; height?: number };

/**
 * The caller's width/height is the asset's INTENDED size, not a fixed one: on a
 * short screen it would push the CTA off the bottom (the screen doesn't
 * scroll). Scale it down — never up — to whatever the slot actually measured,
 * keeping the aspect ratio.
 */
function fitIllustration(illustration: ReactNode, slot: { width: number; height: number }) {
  if (!isValidElement<SizedProps>(illustration) || slot.width <= 0 || slot.height <= 0) {
    return illustration;
  }
  const { width, height } = illustration.props;
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) {
    return illustration;
  }
  const scale = Math.min(1, slot.width / width, slot.height / height);
  if (scale >= 1) return illustration;
  return cloneElement(illustration, {
    width: Math.floor(width * scale),
    height: Math.floor(height * scale),
  });
}

const BrandStatusView: FC<Props> = ({ title, amount, caption, illustration, footer }) => {
  const [slot, setSlot] = useState({ width: 0, height: 0 });

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
      <View direction="column" align="center" gap="md" paddingTop="lg">
        <BrandDisplayTitle>{title}</BrandDisplayTitle>
        {amount ? (
          <Text size="xl" emphasis align="center">
            {amount}
          </Text>
        ) : null}
        {caption ? (
          <Text size="md" muted align="center">
            {caption}
          </Text>
        ) : null}
      </View>

      {/* Structural: the slot is measured so the asset can be scaled into it.
        A DS box models no measurement, and percentage-sized SVG has no definite
        parent to resolve against here. */}
      <RNView
        style={styles.illustrationSlot}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setSlot((current) =>
            Math.round(current.width) === Math.round(width) &&
            Math.round(current.height) === Math.round(height)
              ? current
              : { width, height },
          );
        }}
      >
        <PopRiffleView active>{fitIllustration(illustration, slot)}</PopRiffleView>
      </RNView>

      {footer ?? null}
    </View>
  );
};

const styles = {
  illustrationSlot: {
    flex: 1,
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
} as const;

export default BrandStatusView;
