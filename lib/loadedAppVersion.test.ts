import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  platform: "web",
  isEmbeddedLaunch: false,
  updateId: null as string | null,
  runtimeVersion: null as string | null,
  manifestVersion: "0.96.0",
}));
import { Platform } from "../__mocks__/react-native";
Object.defineProperty(Platform, "OS", { configurable: true, get: () => state.platform });
vi.mock("expo-updates", () => ({
  get isEmbeddedLaunch() {
    return state.isEmbeddedLaunch;
  },
  get updateId() {
    return state.updateId;
  },
  get runtimeVersion() {
    return state.runtimeVersion;
  },
}));
vi.mock("../services/app/AppUpdateService", () => ({
  getBundleAppVersion: () => state.manifestVersion,
}));
import { getLoadedAppIdentity, JS_RELEASE_VERSION } from "./loadedAppVersion";

describe("loaded support version", () => {
  beforeEach(() =>
    Object.assign(state, {
      platform: "web",
      isEmbeddedLaunch: false,
      updateId: null,
      runtimeVersion: null,
      manifestVersion: "0.96.0",
    }),
  );
  it("identifies the compiled web release, not a newer server or manifest", () => {
    expect(JS_RELEASE_VERSION).toBe("0.97.0");
    state.manifestVersion = "9.0.0";
    expect(getLoadedAppIdentity()).toBe("0.97.0 · web");
  });
  it("includes the full running OTA identity and runtime", () => {
    Object.assign(state, {
      platform: "ios",
      updateId: "12345678-abcd-4321-abcd-123456789012",
      runtimeVersion: "runtime-hash",
    });
    expect(getLoadedAppIdentity()).toBe(
      "0.97.0 · ios · OTA 12345678-abcd-4321-abcd-123456789012 · runtime runtime-hash",
    );
  });
  it("distinguishes an embedded native launch from OTA", () => {
    Object.assign(state, { platform: "android", isEmbeddedLaunch: true, updateId: "embedded-id" });
    expect(getLoadedAppIdentity()).toBe("0.97.0 · android · embedded · manifest 0.96.0");
  });
  it("does not invent an OTA identity for development", () => {
    Object.assign(state, { platform: "ios", manifestVersion: "" });
    expect(getLoadedAppIdentity()).toBe("0.97.0 · ios · development");
  });
  it("keeps version before Logout, Share Info and Close with existing guards", () => {
    const source = readFileSync(
      new URL("../components/NostrChatModal.tsx", import.meta.url),
      "utf8",
    );
    const header = source.slice(source.indexOf("<Header safeAreaTop"), source.indexOf("</Header>"));
    expect(header.indexOf("{JS_RELEASE_VERSION}")).toBeLessThan(
      header.indexOf("setShowSwitchPasskeyConfirm(true)"),
    );
    expect(header.indexOf("setShowSwitchPasskeyConfirm(true)")).toBeLessThan(
      header.indexOf("handleSendSupportDump()"),
    );
    expect(header.indexOf("handleSendSupportDump()")).toBeLessThan(header.indexOf('icon="cross"'));
    expect(header).toContain('layout="fluid"');
    expect(header).toContain("<TopbarContent>");
    expect(header).toContain(
      'disabled={!keys || supportDumpState === "sending" || switchingPasskey}',
    );
    expect(header).toContain("disabled={switchingPasskey}");
  });
});
