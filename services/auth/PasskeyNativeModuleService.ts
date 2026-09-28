// Native passkey routing — one switch point for every ceremony call-site.
//
// Android: the compiled-in native PasskeyModule (Credential Manager). The
// shipped Android binaries lack the WebView WebAuthn opt-in
// (WebSettingsCompat.setWebAuthenticationSupport, #868), so the in-WebView
// path reports "WebAuthn is unavailable in this WebView" there. The native
// module is the proven v0.86 production path — same rpId (nuri.com) + same
// PRF salt (nuri-prf-salt-v1) => same wallet — and it ships OTA because the
// module was deliberately left compiled into every binary (dormant).
//
// iOS: the WebView-based WebAuthn PRF bridge (WebAuthnPrfService + the
// always-mounted WebAuthnPrfOverlay), unchanged.
//
// Web resolves to PasskeyNativeModuleService.web.ts (direct
// navigator.credentials in the top-level page).
import { NativeModules, Platform } from "react-native";
import { sanitizePasskeyError } from "../../lib/auth/passkeyError";
import * as WebViewBridge from "./WebAuthnPrfService";

type NativePasskeyResult = {
  prfB64: string;
  credIdB64u?: string;
  credPubkeyB64u?: string;
  isNew: boolean;
};

type NativePasskeyAssertionResult = {
  credIdB64u: string;
  clientDataB64u: string;
  authDataB64u: string;
  sigB64u: string;
};

type NativePasskeyPrfAssertionResult = NativePasskeyAssertionResult & {
  prfB64: string;
};

type NativePasskeyModuleType = {
  createWalletPasskey?: (rpId: string, prfSalt: string) => Promise<NativePasskeyResult>;
  createWalletPasskeyWithLabel?: (
    rpId: string,
    prfSalt: string,
    label: string,
  ) => Promise<NativePasskeyResult>;
  getWalletPasskeyPrf?: (
    rpId: string,
    prfSalt: string,
    credIdB64u?: string | null,
  ) => Promise<NativePasskeyResult>;
  getWalletPasskeyAssertion?: (
    rpId: string,
    challengeB64u: string,
    credIdB64u?: string | null,
  ) => Promise<NativePasskeyAssertionResult>;
};

const passkeyModule = NativeModules.PasskeyModule as NativePasskeyModuleType | undefined;

const useNativeModule =
  Platform.OS === "android" &&
  !!passkeyModule &&
  typeof passkeyModule.createWalletPasskey === "function" &&
  typeof passkeyModule.getWalletPasskeyPrf === "function" &&
  typeof passkeyModule.getWalletPasskeyAssertion === "function";

/** True when Android routes ceremonies through the native PasskeyModule
 *  (login should then render the native screen, not the WebView one). */
export const isNativePasskeyLoginAvailable = (): boolean => useNativeModule;

async function run<T>(step: string, call: () => Promise<T>): Promise<T> {
  const startedAtMs = Date.now();
  try {
    const result = await call();
    console.log(`🔐 [PasskeyNativeModuleService#${step}] ok dur_ms=${Date.now() - startedAtMs}`);
    return result;
  } catch (error) {
    const sanitized = sanitizePasskeyError(error);
    console.log(
      `🔐 [PasskeyNativeModuleService#${step}] failed dur_ms=${Date.now() - startedAtMs} code=${sanitized.code} class=${sanitized.errorName}`,
    );
    throw error;
  }
}

export const createWalletPasskey = (
  rpId: string,
  prfSalt: string,
  labelOverride?: string,
): Promise<NativePasskeyResult> => {
  if (!useNativeModule) return WebViewBridge.createWalletPasskey(rpId, prfSalt, labelOverride);
  const mod = passkeyModule as NativePasskeyModuleType;
  const label = typeof labelOverride === "string" ? labelOverride.trim() : "";
  const withLabel = Boolean(label && typeof mod.createWalletPasskeyWithLabel === "function");
  return run("createWalletPasskey", () =>
    withLabel
      ? (
          mod.createWalletPasskeyWithLabel as NonNullable<
            NativePasskeyModuleType["createWalletPasskeyWithLabel"]
          >
        )(rpId, prfSalt, label)
      : (mod.createWalletPasskey as NonNullable<NativePasskeyModuleType["createWalletPasskey"]>)(
          rpId,
          prfSalt,
        ),
  );
};

// Browser-only split registration exports. Web resolves this module to the
// `.web.ts` implementation; native account creation keeps its existing bridge.
export const createWalletPasskeyCredential = async (
  _rpId: string,
  _prfSalt: string,
  _labelOverride?: string,
): Promise<Omit<NativePasskeyResult, "prfB64">> => {
  throw new Error("create_wallet_passkey_credential_web_only");
};

export const getWalletPasskeyPrfAssertion = async (_params: {
  rpId: string;
  challengeB64u: string;
  credIdB64u?: string;
  prfSalt: string;
}): Promise<NativePasskeyPrfAssertionResult> => {
  throw new Error("wallet_passkey_prf_assertion_web_only");
};

export const useExistingWalletPasskey = (
  rpId: string,
  prfSalt: string,
  credIdB64u?: string | null,
): Promise<NativePasskeyResult> =>
  useNativeModule
    ? run("useExistingWalletPasskey", () =>
        (
          (passkeyModule as NativePasskeyModuleType).getWalletPasskeyPrf as NonNullable<
            NativePasskeyModuleType["getWalletPasskeyPrf"]
          >
        )(rpId, prfSalt, (credIdB64u ?? "").trim()),
      )
    : WebViewBridge.useExistingWalletPasskey(rpId, prfSalt, credIdB64u);

export const getWalletPasskeyAssertion = (params: {
  rpId: string;
  challengeB64u: string;
  credIdB64u?: string;
}): Promise<NativePasskeyAssertionResult> =>
  useNativeModule
    ? run("getWalletPasskeyAssertion", () =>
        (
          (passkeyModule as NativePasskeyModuleType).getWalletPasskeyAssertion as NonNullable<
            NativePasskeyModuleType["getWalletPasskeyAssertion"]
          >
        )(params.rpId, params.challengeB64u, (params.credIdB64u ?? "").trim()),
      )
    : WebViewBridge.getWalletPasskeyAssertion(params);
