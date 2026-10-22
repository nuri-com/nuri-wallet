// components/SendRecipientContact.tsx
// A send screen's recipient when it is a person: their avatar with the name
// below, the way the address book shows a contact. No address: the user picked
// a person, not a string of characters.
import { Image, StyleSheet } from "react-native";

import { Text, View } from "@ds";

import { contactAvatar } from "../lib/addressBook/petAvatar";

type Props = { name: string; nuriUsername?: string };

export default function SendRecipientContact({ name, nuriUsername }: Props) {
  return (
    <View direction="column" align="center" gap="xs" paddingY="sm">
      {/* Raw Image: the DS avatar only comes in list sizes. */}
      <Image
        source={contactAvatar({ label: name, nuriUsername }, "hero")}
        style={styles.avatar}
        accessibilityIgnoresInvertColors
      />
      <Text size="lg" emphasis align="center" flow="truncate" lines={1}>
        {name}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { width: 72, height: 72, borderRadius: 36 },
});
