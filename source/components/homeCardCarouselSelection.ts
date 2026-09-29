export function homeCarouselIndexForKey(
  keys: readonly (string | null)[],
  selectedKey: string | null,
): number {
  return Math.max(0, keys.indexOf(selectedKey));
}

export function homeCarouselLoopTargetAtOffset(
  keys: readonly (string | null)[],
  offsetX: number,
  interval: number,
): { key: string | null; canonicalIndex: number; shouldReset: boolean } {
  if (keys.length === 0 || interval <= 0) {
    return { key: null, canonicalIndex: 0, shouldReset: false };
  }
  if (keys.length === 1) {
    return { key: keys[0] ?? null, canonicalIndex: 0, shouldReset: false };
  }

  const renderedIndex = Math.max(0, Math.min(keys.length + 1, Math.round(offsetX / interval)));
  if (renderedIndex === 0) {
    return {
      key: keys[keys.length - 1] ?? null,
      canonicalIndex: keys.length,
      shouldReset: true,
    };
  }
  if (renderedIndex === keys.length + 1) {
    return { key: keys[0] ?? null, canonicalIndex: 1, shouldReset: true };
  }
  return {
    key: keys[renderedIndex - 1] ?? null,
    canonicalIndex: renderedIndex,
    shouldReset: false,
  };
}

export function homeCarouselIndexAfterAction(
  selectedIndex: number,
  itemCount: number,
  action: string,
): number | null {
  const delta =
    action === "increment" || action === "ArrowRight"
      ? 1
      : action === "decrement" || action === "ArrowLeft"
        ? -1
        : null;
  if (delta === null || itemCount <= 0) return null;
  return (selectedIndex + delta + itemCount) % itemCount;
}

type SettleControllerOptions = {
  delayMs: number;
  onSettle: (offsetX: number) => void;
};

/** Keeps account content fixed while a touch/drag remains held. */
export function createHomeCarouselSettleController({ delayMs, onSettle }: SettleControllerOptions) {
  let interacting = false;
  // Mount/programmatic scrolling is not user intent (offset zero is a clone).
  let acceptingScroll = false;
  let offsetX = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    cancel();
    if (interacting || !acceptingScroll) return;
    timer = setTimeout(() => {
      timer = null;
      if (!interacting && acceptingScroll) onSettle(offsetX);
    }, delayMs);
  };

  return {
    reset() {
      acceptingScroll = false;
      interacting = false;
      cancel();
    },
    start(initialOffsetX = offsetX) {
      offsetX = initialOffsetX;
      acceptingScroll = true;
      interacting = true;
      cancel();
    },
    wheel() {
      acceptingScroll = true;
      interacting = false;
      cancel();
    },
    scroll(nextOffsetX: number) {
      if (!acceptingScroll) return false;
      offsetX = nextOffsetX;
      schedule();
      return true;
    },
    end(nextOffsetX = offsetX) {
      if (!acceptingScroll) return;
      offsetX = nextOffsetX;
      interacting = false;
      schedule();
    },
    settle(nextOffsetX: number) {
      if (!acceptingScroll) return false;
      offsetX = nextOffsetX;
      interacting = false;
      cancel();
      onSettle(offsetX);
      return true;
    },
    dispose: cancel,
  };
}
