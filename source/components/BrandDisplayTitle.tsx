import type React from "react";
import { StyleSheet, Text as RNText } from "react-native";
import { useNuriTheme } from "@ds";

// Brand display type (Harriet thin, app-loaded font) for fullscreen titles —
// the DS type scale carries no display font, so this stays a raw brand style
// (like the landing background image). Color comes from the DS text token.
const BrandDisplayTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const theme = useNuriTheme();
  return <RNText style={[styles.title, { color: theme.text.primary }]}>{children}</RNText>;
};

const styles = StyleSheet.create({
  title: {
    fontFamily: "HarrietDisplayThin",
    fontSize: 40,
    // Harriet's descenders sit below the em box, so a lineHeight equal to the
    // font size clips the tail of a "g"/"p". 1.2 gives them room.
    lineHeight: 48,
    textAlign: "center",
  },
});

export default BrandDisplayTitle;
