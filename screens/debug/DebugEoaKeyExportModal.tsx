import { Wallet } from "ethers";
import * as Clipboard from "expo-clipboard";
import * as musig2 from "@scure/btc-signer/musig2.js";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  ButtonIcon,
  ButtonText,
  Header,
  IconButton,
  Scroll,
  Text,
  Topbar,
  TopbarTrailing,
  View,
} from "@ds";
import DsSheetHost from "../../components/DsSheetHost";
import { bytesToHex, zeroize } from "../../lib/crypto";
import {
  getBitcoinAddress,
  getBitcoinPublicKey,
  getEthereumAddress,
  getEthereumPublicKey,
  getPrivateKey,
} from "../../lib/secureKeyStorage";
import type { DebugEoaKeyExportProps } from "../../types/debug";

type Props = DebugEoaKeyExportProps;

type RevealState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "revealed";
      privateKeyHex: string;
      derivedAddress: string;
      derivedPublicKey: string;
    }
  | { kind: "error"; message: string };

type BitcoinRevealState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "revealed";
      privateKeyHex: string;
      derivedPublicKey: string;
    }
  | { kind: "error"; message: string };

const initialRevealState: RevealState = { kind: "idle" };
const initialBitcoinRevealState: BitcoinRevealState = { kind: "idle" };

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "unknown");
}

function compareAddress(a?: string | null, b?: string | null): string {
  if (!a || !b) return "unknown";
  return a.toLowerCase() === b.toLowerCase() ? "match" : "mismatch";
}

function comparePublicKey(a?: string | null, b?: string | null): string {
  if (!a || !b) return "unknown";
  return a.toLowerCase() === b.toLowerCase() ? "match" : "mismatch";
}

export default function DebugEoaKeyExportModal({ visible, onClose }: Props) {
  const [storedAddress, setStoredAddress] = useState<string | null>(null);
  const [storedPublicKey, setStoredPublicKey] = useState<string | null>(null);
  const [storedBitcoinAddress, setStoredBitcoinAddress] = useState<string | null>(null);
  const [storedBitcoinPublicKey, setStoredBitcoinPublicKey] = useState<string | null>(null);
  const [revealState, setRevealState] = useState<RevealState>(initialRevealState);
  const [bitcoinRevealState, setBitcoinRevealState] =
    useState<BitcoinRevealState>(initialBitcoinRevealState);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const clearSensitiveState = useCallback(() => {
    setRevealState(initialRevealState);
    setBitcoinRevealState(initialBitcoinRevealState);
    setCopyStatus(null);
  }, []);

  useEffect(() => {
    if (!visible) {
      clearSensitiveState();
      return;
    }

    let cancelled = false;
    void (async () => {
      const [address, publicKey, bitcoinAddress, bitcoinPublicKey] = await Promise.all([
        getEthereumAddress().catch((): null => null),
        getEthereumPublicKey().catch((): null => null),
        getBitcoinAddress().catch((): null => null),
        getBitcoinPublicKey().catch((): null => null),
      ]);
      if (cancelled) return;
      setStoredAddress(address);
      setStoredPublicKey(publicKey);
      setStoredBitcoinAddress(bitcoinAddress);
      setStoredBitcoinPublicKey(bitcoinPublicKey);
    })();

    return () => {
      cancelled = true;
    };
  }, [visible, clearSensitiveState]);

  const handleReveal = useCallback(() => {
    void (async () => {
      let keyBytes: Uint8Array | null = null;
      setRevealState({ kind: "loading" });
      setCopyStatus(null);
      try {
        keyBytes = await getPrivateKey("ethereum");
        const privateKeyHex = `0x${bytesToHex(keyBytes)}`;
        const wallet = new Wallet(privateKeyHex);
        setRevealState({
          kind: "revealed",
          privateKeyHex,
          derivedAddress: wallet.address,
          derivedPublicKey: wallet.signingKey.publicKey,
        });
      } catch (error: unknown) {
        setRevealState({ kind: "error", message: describeError(error) });
      } finally {
        if (keyBytes) zeroize(keyBytes);
      }
    })();
  }, []);

  const handleRevealBitcoin = useCallback(() => {
    void (async () => {
      let keyBytes: Uint8Array | null = null;
      setBitcoinRevealState({ kind: "loading" });
      setCopyStatus(null);
      try {
        keyBytes = await getPrivateKey("bitcoin");
        const privateKeyHex = bytesToHex(keyBytes);
        const derivedPublicKey = bytesToHex(musig2.IndividualPubkey(keyBytes)).toLowerCase();
        setBitcoinRevealState({
          kind: "revealed",
          privateKeyHex,
          derivedPublicKey,
        });
      } catch (error: unknown) {
        setBitcoinRevealState({ kind: "error", message: describeError(error) });
      } finally {
        if (keyBytes) zeroize(keyBytes);
      }
    })();
  }, []);

  const copyValue = useCallback(async (label: string, value?: string | null) => {
    if (!value) return;
    try {
      await Clipboard.setStringAsync(value);
      setCopyStatus(`${label} copied`);
    } catch {
      setCopyStatus(`${label} copy failed`);
    }
  }, []);

  const derivedAddress = revealState.kind === "revealed" ? revealState.derivedAddress : null;
  const derivedPublicKey = revealState.kind === "revealed" ? revealState.derivedPublicKey : null;
  const privateKeyHex = revealState.kind === "revealed" ? revealState.privateKeyHex : null;
  const bitcoinPrivateKeyHex =
    bitcoinRevealState.kind === "revealed" ? bitcoinRevealState.privateKeyHex : null;
  const bitcoinDerivedPublicKey =
    bitcoinRevealState.kind === "revealed" ? bitcoinRevealState.derivedPublicKey : null;

  const handleClose = () => {
    clearSensitiveState();
    onClose();
  };

  return (
    <DsSheetHost visible={visible} onClose={handleClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent">
          <TopbarTrailing>
            <IconButton
              icon="cross"
              variant="soft"
              accessibilityLabel="Close"
              onPress={handleClose}
            />
          </TopbarTrailing>
        </Topbar>
      </Header>
      <Scroll safeAreaBottom>
        <View direction="column" align="stretch" gap="lg" paddingX="lg" paddingBottom="lg">
          <Text size="lg" emphasis>
            EOA Key Export
          </Text>

          <View
            variant="soft"
            accent="orange"
            radius="lg"
            padding="lg"
            direction="column"
            align="stretch"
            gap="xs"
          >
            <Text size="md" emphasis>
              Private key export
            </Text>
            <Text size="sm">
              Revealing these keys compromises every asset controlled by the matching wallet. Do not
              paste them into chats, logs, tickets, screenshots, or websites you do not fully trust.
            </Text>
          </View>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="sm">
            <Text size="md" emphasis>
              Stored Ethereum public data
            </Text>
            <ValueRow label="Stored EOA address" value={storedAddress ?? "not found"} />
            <Button
              variant="soft"
              size="sm"
              onPress={() => void copyValue("address", storedAddress)}
              disabled={!storedAddress}
            >
              <ButtonIcon name="copy" />
              <ButtonText>Copy address</ButtonText>
            </Button>
            <ValueRow label="Stored public key" value={storedPublicKey ?? "not found"} />
            <Button
              variant="soft"
              size="sm"
              onPress={() => void copyValue("public key", storedPublicKey)}
              disabled={!storedPublicKey}
            >
              <ButtonIcon name="copy" />
              <ButtonText>Copy public key</ButtonText>
            </Button>
          </View>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="sm">
            <Text size="md" emphasis>
              Stored Bitcoin public data
            </Text>
            <ValueRow label="Stored Bitcoin address" value={storedBitcoinAddress ?? "not found"} />
            <Button
              variant="soft"
              size="sm"
              onPress={() => void copyValue("Bitcoin address", storedBitcoinAddress)}
              disabled={!storedBitcoinAddress}
            >
              <ButtonIcon name="copy" />
              <ButtonText>Copy Bitcoin address</ButtonText>
            </Button>
            <ValueRow
              label="Stored Bitcoin public key"
              value={storedBitcoinPublicKey ?? "not found"}
            />
            <Button
              variant="soft"
              size="sm"
              onPress={() => void copyValue("Bitcoin public key", storedBitcoinPublicKey)}
              disabled={!storedBitcoinPublicKey}
            >
              <ButtonIcon name="copy" />
              <ButtonText>Copy Bitcoin public key</ButtonText>
            </Button>
          </View>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="sm">
            <Text size="md" emphasis>
              Ethereum private key
            </Text>
            <Button
              variant="solid"
              accent="lilac"
              size="sm"
              onPress={handleReveal}
              disabled={revealState.kind === "loading"}
            >
              <ButtonIcon name="eye" />
              <ButtonText>
                {revealState.kind === "loading" ? "Unlocking..." : "Reveal private key"}
              </ButtonText>
            </Button>
            {revealState.kind === "error" ? (
              <Text size="md" muted>
                {revealState.message}
              </Text>
            ) : null}
            {privateKeyHex ? (
              <>
                <ValueRow label="Private key" value={privateKeyHex} sensitive />
                <Button
                  variant="soft"
                  size="sm"
                  onPress={() => void copyValue("private key", privateKeyHex)}
                >
                  <ButtonIcon name="copy" />
                  <ButtonText>Copy private key</ButtonText>
                </Button>
                <ValueRow label="Derived address" value={derivedAddress ?? "not found"} />
                <ValueRow label="Derived public key" value={derivedPublicKey ?? "not found"} />
                <ValueRow
                  label="Address check"
                  value={compareAddress(storedAddress, derivedAddress)}
                />
                <ValueRow
                  label="Public key check"
                  value={comparePublicKey(storedPublicKey, derivedPublicKey)}
                />
              </>
            ) : null}
          </View>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="sm">
            <Text size="md" emphasis>
              Bitcoin native private key
            </Text>
            <Button
              variant="solid"
              accent="lilac"
              size="sm"
              onPress={handleRevealBitcoin}
              disabled={bitcoinRevealState.kind === "loading"}
            >
              <ButtonIcon name="eye" />
              <ButtonText>
                {bitcoinRevealState.kind === "loading" ? "Unlocking..." : "Reveal Bitcoin key"}
              </ButtonText>
            </Button>
            {bitcoinRevealState.kind === "error" ? (
              <Text size="md" muted>
                {bitcoinRevealState.message}
              </Text>
            ) : null}
            {bitcoinPrivateKeyHex ? (
              <>
                <ValueRow label="Bitcoin private key hex" value={bitcoinPrivateKeyHex} sensitive />
                <Button
                  variant="soft"
                  size="sm"
                  onPress={() => void copyValue("Bitcoin private key", bitcoinPrivateKeyHex)}
                >
                  <ButtonIcon name="copy" />
                  <ButtonText>Copy Bitcoin private key</ButtonText>
                </Button>
                <ValueRow
                  label="Derived Bitcoin public key"
                  value={bitcoinDerivedPublicKey ?? "not found"}
                />
                <ValueRow
                  label="Bitcoin public key check"
                  value={comparePublicKey(storedBitcoinPublicKey, bitcoinDerivedPublicKey)}
                />
              </>
            ) : null}
          </View>

          {copyStatus ? (
            <Text size="sm" muted>
              {copyStatus}
            </Text>
          ) : null}
        </View>
      </Scroll>
    </DsSheetHost>
  );
}

function ValueRow({
  label,
  value,
  sensitive,
}: {
  label: string;
  value: string;
  sensitive?: boolean;
}) {
  return (
    <View direction="column" align="stretch" gap="xs">
      <Text size="xs" muted>
        {label}
      </Text>
      {sensitive ? (
        <View
          variant="soft"
          accent="orange"
          radius="md"
          padding="sm"
          direction="column"
          align="stretch"
        >
          <Text size="sm" mono>
            {value}
          </Text>
        </View>
      ) : (
        <Text size="sm" mono>
          {value}
        </Text>
      )}
    </View>
  );
}
