import * as React from "react";
import {
  Image as RNImage,
  Platform,
  ScrollView as RNScrollView,
  StyleSheet,
  Text as RNText,
  View as RNView,
  useWindowDimensions,
  type ImageSourcePropType,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import {
  Button,
  ButtonText,
  IconAvatar,
  NuriScope,
  Text,
  typeStyle,
  useNuriTheme,
  View,
} from "@ds";
import NuriVisaCardArtwork from "../assets/cards/nuri-visa-platinum.svg";
import {
  createHomeCarouselSettleController,
  homeCarouselIndexAfterAction,
  homeCarouselIndexForKey,
  homeCarouselLoopTargetAtOffset,
} from "./homeCardCarouselSelection";

const SPACE_SM = 6;
const SPACE_LG = 18;
const SIZE_LG = 48;
const CARD_ASPECT_RATIO = 1.586;
const SETTLE_DELAY_MS = 100;
const inactiveVisaCardArtwork = require("../assets/cards/nuri-card-visa-platinum-inactive.jpg");

export type HomeCarouselItem = {
  key: string;
  label: string;
  image: ImageSourcePropType;
  amount: string;
  converted?: string | null;
  detailsLabel?: string;
  onDetails?: () => void;
  inactiveVisaArtwork?: boolean;
};

type HomeCarouselSlide = {
  key: string | null;
  label: string;
  amount: string;
  converted?: string | null;
  images: ImageSourcePropType[];
  detailsLabel?: string;
  onDetails?: () => void;
  inactiveVisaArtwork?: boolean;
};

type HomeCarouselRenderedSlide = HomeCarouselSlide & {
  renderKey: string;
  clone: boolean;
};

type Props = {
  totalLabel: string;
  totalAmount: string;
  totalImages: ImageSourcePropType[];
  items: HomeCarouselItem[];
  selectedKey: string | null;
  /** Changes only for explicit navigation/reset, never ordinary swipe selection. */
  navigationRevision?: number;
  onSelect: (key: string | null) => void;
  onInteraction?: () => void;
};

const VisaBalanceText: React.FC<{ amount: string; converted?: string | null }> = ({
  amount,
  converted,
}) => {
  const theme = useNuriTheme();
  return (
    <>
      <RNText style={[typeStyle("3xl"), { color: theme.text.onInverse }]}>{amount}</RNText>
      {converted ? (
        <RNText style={[typeStyle("md"), { color: theme.text.onInverse }]}>{converted}</RNText>
      ) : null}
    </>
  );
};

const VisaLabelText: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const theme = useNuriTheme();
  return (
    <RNText style={[typeStyle("md", true), { color: theme.text.onInverse }]}>{children}</RNText>
  );
};

const BalanceCard: React.FC<{
  label: string;
  amount: string;
  converted?: string | null;
  images: ImageSourcePropType[];
  visaArtwork?: boolean;
  inactiveVisaArtwork?: boolean;
  detailsLabel?: string;
  onDetails?: () => void;
}> = ({
  label,
  amount,
  converted,
  images,
  visaArtwork,
  inactiveVisaArtwork,
  detailsLabel,
  onDetails,
}) => {
  if (inactiveVisaArtwork) {
    return (
      <RNView style={styles.visaCard}>
        <RNImage
          source={inactiveVisaCardArtwork}
          resizeMode="cover"
          style={styles.inactiveVisaArtwork}
        />
      </RNView>
    );
  }

  const content = (
    <>
      <View height="lg" direction="row" align="center" justify="between">
        <View direction="row" align="center" gap="sm">
          {images[0] ? <IconAvatar size="sm" source={images[0]} /> : null}
          {images[1] ? <IconAvatar size="sm" source={images[1]} /> : null}
          {visaArtwork ? (
            <NuriScope mode="light">
              <VisaLabelText>{label}</VisaLabelText>
            </NuriScope>
          ) : (
            <Text size="md" emphasis>
              {label}
            </Text>
          )}
        </View>
        {onDetails && detailsLabel ? (
          <NuriScope mode="light">
            <Button size="sm" variant="soft" accessibilityLabel={detailsLabel} onPress={onDetails}>
              <ButtonText>{detailsLabel}</ButtonText>
            </Button>
          </NuriScope>
        ) : null}
      </View>
      <View height="3xl" direction="column" align="end" justify="start">
        {visaArtwork ? (
          <NuriScope mode="light">
            <VisaBalanceText amount={amount} converted={converted} />
          </NuriScope>
        ) : (
          <>
            <Text size="3xl" align="end">
              {amount}
            </Text>
            {converted ? (
              <Text size="md" align="end" muted>
                {converted}
              </Text>
            ) : null}
          </>
        )}
      </View>
    </>
  );

  if (visaArtwork) {
    return (
      <RNView style={styles.visaCard}>
        <NuriVisaCardArtwork
          width="100%"
          height="100%"
          preserveAspectRatio="xMinYMid slice"
          pointerEvents="none"
          style={StyleSheet.absoluteFillObject}
        />
        <View padding="md" direction="column" justify="between" align="stretch" fill="grow">
          {content}
        </View>
      </RNView>
    );
  }

  return (
    <View
      chrome="strong"
      radius="lg"
      padding="md"
      direction="column"
      justify="between"
      align="stretch"
      fill="grow"
    >
      {content}
    </View>
  );
};

/**
 * Presentation-only home navigation. Balances and actions remain owned by the
 * home screen; this rail reports a key only after scrolling has settled.
 */
const HomeCardCarousel: React.FC<Props> = ({
  totalLabel,
  totalAmount,
  totalImages,
  items,
  selectedKey,
  navigationRevision = 0,
  onSelect,
  onInteraction,
}) => {
  const { width } = useWindowDimensions();
  const side = SPACE_LG;
  const gap = SPACE_SM;
  const cardWidth = width - 2 * SPACE_LG - SIZE_LG / 2;
  const cardHeight = Math.round((width - 2 * SPACE_LG) / CARD_ASPECT_RATIO);
  const interval = cardWidth + gap;
  const scrollRef = React.useRef<RNScrollView>(null);
  const slides = React.useMemo<HomeCarouselSlide[]>(
    () => [
      { key: null, label: totalLabel, amount: totalAmount, images: totalImages },
      ...items.map((item) => ({
        key: item.key,
        label: item.label,
        amount: item.amount,
        converted: item.converted,
        images: [item.image],
        detailsLabel: item.detailsLabel,
        onDetails: item.onDetails,
        inactiveVisaArtwork: item.inactiveVisaArtwork,
      })),
    ],
    [items, totalAmount, totalImages, totalLabel],
  );
  const keys = React.useMemo(() => slides.map((slide) => slide.key), [slides]);
  const renderedSlides = React.useMemo<HomeCarouselRenderedSlide[]>(() => {
    const realSlides = slides.map((slide, index) => ({
      ...slide,
      renderKey: `real-${index}`,
      clone: false,
    }));
    if (slides.length <= 1) return realSlides;
    return [
      { ...slides[slides.length - 1], renderKey: "clone-last", clone: true },
      ...realSlides,
      { ...slides[0], renderKey: "clone-first", clone: true },
    ];
  }, [slides]);
  const isLooping = slides.length > 1;
  const selectedIndex = homeCarouselIndexForKey(keys, selectedKey);
  const selectedRenderedIndex = isLooping ? selectedIndex + 1 : selectedIndex;

  const scrollToSelected = React.useCallback(() => {
    scrollRef.current?.scrollTo({ x: selectedRenderedIndex * interval, animated: false });
  }, [interval, selectedRenderedIndex]);

  const selectOffset = React.useCallback(
    (x: number) => {
      const target = homeCarouselLoopTargetAtOffset(keys, x, interval);
      onSelect(target.key);
      if (target.shouldReset) {
        scrollRef.current?.scrollTo({ x: target.canonicalIndex * interval, animated: false });
      }
    },
    [interval, keys, onSelect],
  );
  const selectOffsetRef = React.useRef(selectOffset);
  selectOffsetRef.current = selectOffset;

  const settleController = React.useMemo(
    () =>
      createHomeCarouselSettleController({
        delayMs: SETTLE_DELAY_MS,
        onSettle: (offsetX) => selectOffsetRef.current(offsetX),
      }),
    [],
  );

  const onScroll = React.useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!settleController.scroll(event.nativeEvent.contentOffset.x)) scrollToSelected();
    },
    [settleController, scrollToSelected],
  );

  const startSettling = React.useCallback(() => {
    settleController.start(selectedRenderedIndex * interval);
  }, [settleController, selectedRenderedIndex, interval]);

  const onScrollBeginDrag = React.useCallback(() => {
    onInteraction?.();
    startSettling();
  }, [onInteraction, startSettling]);

  const onTouchMove = React.useCallback(() => {
    onInteraction?.();
  }, [onInteraction]);

  const onScrollEndDrag = React.useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      settleController.end(event.nativeEvent.contentOffset.x);
    },
    [settleController],
  );

  const onMomentumScrollEnd = React.useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!settleController.settle(event.nativeEvent.contentOffset.x)) scrollToSelected();
    },
    [settleController, scrollToSelected],
  );

  // Cancel before scroll/end events can overwrite the explicit target. Old
  // touch moves do not reopen the gate; only a new touch/drag/wheel does.
  const appliedNavigationRevision = React.useRef(navigationRevision);
  React.useLayoutEffect(() => {
    if (appliedNavigationRevision.current === navigationRevision) return;
    appliedNavigationRevision.current = navigationRevision;
    settleController.reset();
    scrollToSelected();
  }, [navigationRevision, settleController, scrollToSelected]);

  React.useEffect(() => {
    const timer = setTimeout(scrollToSelected, 0);
    return () => clearTimeout(timer);
  }, [scrollToSelected]);

  React.useEffect(() => () => settleController.dispose(), [settleController]);

  const selectIndex = React.useCallback(
    (index: number) => {
      settleController.reset();
      const renderedIndex = isLooping ? index + 1 : index;
      scrollRef.current?.scrollTo({ x: renderedIndex * interval, animated: false });
      onSelect(slides[index]?.key ?? null);
    },
    [interval, isLooping, onSelect, slides, settleController],
  );

  const selectByAction = React.useCallback(
    (action: string) => {
      const index = homeCarouselIndexAfterAction(selectedIndex, slides.length, action);
      if (index !== null) {
        onInteraction?.();
        selectIndex(index);
      }
    },
    [onInteraction, selectIndex, selectedIndex, slides.length],
  );

  const onAccessibilityAction = React.useCallback(
    (event: { nativeEvent: { actionName: string } }) => {
      selectByAction(event.nativeEvent.actionName);
    },
    [selectByAction],
  );

  const selectedSlide = slides[selectedIndex];
  const accessibilityValueText = `${selectedSlide?.amount ?? totalAmount}, ${selectedIndex + 1} of ${slides.length}`;

  const webKeyboardProps =
    Platform.OS === "web"
      ? ({
          tabIndex: 0,
          onWheel: () => {
            onInteraction?.();
            settleController.wheel();
          },
          "aria-valuemin": 1,
          "aria-valuemax": slides.length,
          "aria-valuenow": selectedIndex + 1,
          "aria-valuetext": accessibilityValueText,
          onKeyDown: (event: {
            key?: string;
            nativeEvent?: { key?: string };
            preventDefault?: () => void;
          }) => {
            const key = event.key ?? event.nativeEvent?.key ?? "";
            if (homeCarouselIndexAfterAction(selectedIndex, slides.length, key) === null) return;
            event.preventDefault?.();
            selectByAction(key);
          },
        } as object)
      : null;

  const webSnap =
    Platform.OS === "web"
      ? ({ scrollSnapType: "x mandatory", scrollPaddingLeft: side } as object)
      : null;
  const webItemSnap = Platform.OS === "web" ? ({ scrollSnapAlign: "start" } as object) : null;

  return (
    <RNScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      snapToInterval={interval}
      disableIntervalMomentum
      decelerationRate="fast"
      scrollEventThrottle={16}
      onScroll={onScroll}
      onScrollBeginDrag={onScrollBeginDrag}
      onScrollEndDrag={onScrollEndDrag}
      onTouchStart={startSettling}
      onTouchMove={onTouchMove}
      onTouchEnd={() => settleController.end()}
      onTouchCancel={() => settleController.end()}
      onMomentumScrollEnd={onMomentumScrollEnd}
      onContentSizeChange={scrollToSelected}
      style={[{ flexGrow: 0 }, webSnap]}
      contentContainerStyle={{
        paddingLeft: side,
        paddingRight: width - side - cardWidth,
        gap,
      }}
      accessibilityRole="adjustable"
      accessibilityLabel={selectedSlide?.label ?? totalLabel}
      accessibilityValue={{ text: accessibilityValueText }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={onAccessibilityAction}
      {...webKeyboardProps}
    >
      {renderedSlides.map((slide) => (
        <RNView
          key={slide.renderKey}
          style={[{ width: cardWidth, height: cardHeight }, webItemSnap]}
          accessible={!slide.clone}
          accessibilityElementsHidden={slide.clone}
          importantForAccessibility={slide.clone ? "no-hide-descendants" : "auto"}
          accessibilityLabel={`${slide.label}, ${slide.amount}`}
          accessibilityState={{ selected: !slide.clone && slide.key === selectedKey }}
          {...(slide.clone && Platform.OS === "web" ? ({ "aria-hidden": true } as object) : null)}
        >
          <BalanceCard
            label={slide.label}
            amount={slide.amount}
            converted={slide.converted}
            images={slide.images}
            visaArtwork={slide.key === "visa"}
            inactiveVisaArtwork={slide.inactiveVisaArtwork}
            detailsLabel={slide.clone ? undefined : slide.detailsLabel}
            onDetails={slide.clone ? undefined : slide.onDetails}
          />
        </RNView>
      ))}
    </RNScrollView>
  );
};

const styles = StyleSheet.create({
  visaCard: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
    borderRadius: SPACE_LG,
  },
  inactiveVisaArtwork: {
    position: "absolute",
    top: 0,
    right: 0,
    width: "100%",
    height: "100%",
  },
});

export default HomeCardCarousel;
