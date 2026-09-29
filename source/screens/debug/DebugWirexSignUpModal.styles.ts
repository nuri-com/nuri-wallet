import { StyleSheet } from "react-native";

// Structural styles only — DS props cannot size or clip the embedded WebView.
export const styles = StyleSheet.create({
  passkeyWebviewContainer: {
    borderRadius: 12,
    overflow: "hidden",
  },
  passkeyWebview: {
    height: 300,
    backgroundColor: "#FFFFFF",
  },
});
