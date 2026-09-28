// @screen app.faq
import React, { useEffect, useState } from "react";
import { LayoutAnimation, Platform, UIManager } from "react-native";
import {
  Header,
  IconButton,
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListActionTrailIcon,
  ListSeparator,
  Scroll,
  Text,
  Topbar,
  TopbarTrailing,
  View,
} from "@ds";
import DsSheetHost from "./DsSheetHost";
import { t } from "../lib/i18n";

type Props = {
  visible: boolean;
  onClose: () => void;
};

const FAQ_ITEMS = [
  {
    question: "Can I export my private key?",
    answer: "Your Passkey is your private key.",
  },
];

const FAQModal: React.FC<Props> = ({ visible, onClose }) => {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  useEffect(() => {
    if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  useEffect(() => {
    if (!visible) {
      setOpenIndex(null);
    }
  }, [visible]);

  const toggleIndex = (index: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpenIndex((current) => (current === index ? null : index));
  };

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent">
          <TopbarTrailing>
            <IconButton
              icon="cross"
              variant="soft"
              accessibilityLabel={t("common.close")}
              onPress={onClose}
            />
          </TopbarTrailing>
        </Topbar>
      </Header>

      <Scroll safeAreaBottom>
        <View direction="column" align="stretch" justify="start" gap="xl" paddingBottom="lg">
          <View paddingX="lg">
            <Text size="lg" emphasis>
              FAQ
            </Text>
          </View>

          <List>
            {FAQ_ITEMS.map((item, index) => {
              const expanded = openIndex === index;
              return (
                <React.Fragment key={item.question}>
                  {index > 0 ? <ListSeparator /> : null}
                  <ListAction accessibilityLabel={item.question} onPress={() => toggleIndex(index)}>
                    <ListActionLeadingAvatar name="headphones" variant="outline" />
                    <ListActionText>{item.question}</ListActionText>
                    <ListActionTrailIcon name={expanded ? "chevron-up" : "chevron-right"} />
                  </ListAction>
                  {expanded ? (
                    <View paddingX="lg" paddingBottom="md">
                      <Text size="md" muted>
                        {item.answer}
                      </Text>
                    </View>
                  ) : null}
                </React.Fragment>
              );
            })}
          </List>
        </View>
      </Scroll>
    </DsSheetHost>
  );
};

export default FAQModal;
