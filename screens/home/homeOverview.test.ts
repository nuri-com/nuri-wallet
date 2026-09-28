import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOME_RAIL_ORDER,
  homeOverviewGroups,
  orderHomeRails,
  overviewEuro,
  sumKnownEuro,
} from "./homeOverview";

const screen = readFileSync(new URL("./UnifiedHomeScreen.tsx", import.meta.url), "utf8");

describe("Total Balance overview", () => {
  it("has exactly three ordered groups and counts shared Wirex funds once", () => {
    const groups = homeOverviewGroups({
      bitcoinEur: 30,
      walletEur: 20,
      dollarEur: 9,
      wirexEur: 15,
    });
    expect(groups).toEqual([
      { key: "bitcoin", rail: "onchain", amountEur: 30 },
      { key: "cash", rail: "wallet", amountEur: 29 },
      { key: "banking", rail: "visa", amountEur: 15 },
    ]);
    expect(sumKnownEuro(groups.map((group) => group.amountEur))).toBe(74);
  });

  it("retains every group at zero", () => {
    const groups = homeOverviewGroups({ bitcoinEur: 0, walletEur: 0, dollarEur: 0, wirexEur: 0 });
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => overviewEuro(group.amountEur))).toEqual([
      "€ 0.00",
      "€ 0.00",
      "€ 0.00",
    ]);
  });

  it("does not present missing balances or conversion rates as zero or a partial sum", () => {
    const groups = homeOverviewGroups({
      bitcoinEur: null,
      walletEur: 20,
      dollarEur: null,
      wirexEur: null,
    });
    expect(groups.map((group) => overviewEuro(group.amountEur))).toEqual(["—", "—", "—"]);
    expect(sumKnownEuro(groups.map((group) => group.amountEur))).toBeNull();
    expect(sumKnownEuro([Number.NaN, 20])).toBeNull();
    expect(overviewEuro(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("writes only ungrouped euro amounts with two decimals", () => {
    expect(overviewEuro(12345.6)).toBe("€ 12345.60");
    expect(overviewEuro(0.125)).toBe("€ 0.13");
  });

  it("keeps each pair adjacent regardless of balances and input order", () => {
    const rails = [...HOME_RAIL_ORDER]
      .reverse()
      .map((key, index) => ({ key, homeValueEur: index }));
    const before = [...rails];
    expect(orderHomeRails(rails).map(({ key }) => key)).toEqual(HOME_RAIL_ORDER);
    expect(
      orderHomeRails(rails.map((rail) => ({ ...rail, homeValueEur: 0 }))).map(({ key }) => key),
    ).toEqual(HOME_RAIL_ORDER);
    expect(rails).toEqual(before);
    for (const [first, next] of [
      ["onchain", "arkade"],
      ["wallet", "dollar"],
      ["visa", "iban"],
    ]) {
      const ordered = orderHomeRails(rails).map(({ key }) => key as string);
      expect(ordered[ordered.indexOf(first) + 1]).toBe(next);
    }
  });
});

// Screen-wiring regressions complement the pure tests without mounting native
// wallet/auth services. Runtime carousel gesture QA remains a platform check.
describe("overview navigation wiring", () => {
  it("selects explicit overview navigation, including Total, without startup machinery", () => {
    expect(screen).toMatch(
      /const selectOverviewRail = useCallback\(\(key: RailKey \| null\) => \{\s*setOpenRail\(key\);/,
    );
    expect(screen).not.toContain("carouselSelectionTouchedRef");
    expect(screen).not.toContain("homeCarouselPreferredKey");
    expect(screen).not.toContain("preferredCarouselRailKey");
    expect(screen).toContain("onPress={() => selectOverviewRail(group.rail)}");
  });

  it("starts and resets on Total with no balance-driven selection writes", () => {
    expect(screen).toContain("const [openRail, setOpenRail] = useState<RailKey | null>(null);");
    expect(screen).toMatch(
      /EventBus.on\("ui:resetMainScreens", \(\) => \{\s*try \{\s*lifecycle.closeAll\(\);\s*cancelMoveHandoff\(\);\s*setOpenRail\(null\);/,
    );
    expect(screen.match(/setOpenRail\([^)]*\)/g)).toEqual([
      "setOpenRail(key)",
      "setOpenRail(key)",
      "setOpenRail(null)",
      "setOpenRail(key as RailKey | null)",
      "setOpenRail(null)",
    ]);
    expect(screen).toContain("if (parked) openRailRow(parked);");
    expect(screen).toContain("if (key) openRailRow(key);");
    expect(screen).toContain("onSelect={(key) => setOpenRail(key as RailKey | null)}");
  });

  it("cancels scrolling only for explicit group/X navigation and app-wide reset, not swipes", () => {
    expect(screen).toContain(
      "const [carouselNavigationRevision, setCarouselNavigationRevision] = useState(0);",
    );
    expect(screen).toMatch(/<HomeCardCarousel\s+navigationRevision=\{carouselNavigationRevision\}/);
    expect(screen).not.toContain("key={carouselNavigationRevision}");
    expect(screen).toMatch(
      /const selectOverviewRail = useCallback\(\(key: RailKey \| null\) => \{\s*setOpenRail\(key\);\s*setCarouselNavigationRevision\(\(revision\) => revision \+ 1\);\s*\}, \[\]\);/,
    );
    expect(screen).toMatch(
      /EventBus.on\("ui:resetMainScreens", \(\) => \{\s*try \{\s*lifecycle.closeAll\(\);\s*cancelMoveHandoff\(\);\s*setOpenRail\(null\);\s*setCarouselNavigationRevision\(\(revision\) => revision \+ 1\);/,
    );
    // Enumerate every revision write: ordinary onSelect (including swipe to
    // Total) must not destroy the active gesture or remount on each selection.
    expect(screen.match(/setCarouselNavigationRevision\(/g)).toHaveLength(2);
    expect(screen).toContain("onSelect={(key) => setOpenRail(key as RailKey | null)}");
    expect(screen).toContain("onPress={() => selectOverviewRail(group.rail)}");
    expect(screen).toContain(
      "carouselRailKey === null ? setScanVisible(true) : selectOverviewRail(null)",
    );
  });

  it("scans only on Total and closes every selected rail without opening onboarding", () => {
    expect(screen).toContain('icon={carouselRailKey === null ? "qr-scan" : "cross"}');
    expect(screen).toContain(
      "carouselRailKey === null ? setScanVisible(true) : selectOverviewRail(null)",
    );
    expect(screen).toContain('"screen.HomeScreen.backToTotalA11yLabel"');
    expect(screen).toContain(
      "const carouselRails = useMemo(() => orderHomeRails(homeRails), [homeRails]);",
    );
    expect(screen).not.toContain("displayRails.map");
  });
});
