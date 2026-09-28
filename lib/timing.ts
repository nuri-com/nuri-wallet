import { Platform } from "react-native";

export const IOS_MODAL_TRANSITION_DELAY_MS = Platform.OS === "ios" ? 350 : 0;
