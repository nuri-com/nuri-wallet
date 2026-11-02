// The amount card of every send screen: one dark card holding which balance
// (or method) pays on top and the figure at the bottom right. Bitcoin send,
// Cash send and the public pay page all draw it from here, so the card cannot
// drift between them.
import type React from "react";

import { NuriScope, View } from "@ds";

type Props = {
  /** Takes the height the keypad leaves (amount entry); off for a read-only summary. */
  grow?: boolean;
  children: React.ReactNode;
};

export default function SendAmountCard({ grow = true, children }: Props) {
  return (
    <NuriScope mode="dark">
      <View
        chrome="subtle"
        radius="lg"
        paddingX="lg"
        paddingY="md"
        direction="column"
        align="stretch"
        gap="sm"
        {...(grow ? { fill: "grow" as const } : {})}
      >
        {children}
      </View>
    </NuriScope>
  );
}
