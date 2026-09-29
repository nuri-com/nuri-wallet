import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
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
import Spinner from "../../components/Spinner";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { formatUnits } from "viem";
import {
  fetchSatoraCollabRefundParams,
  loadSatoraOnchainLock,
  SATORA_REFUND_OWNER,
  SATORA_REFUND_SWAP_ID,
  type SatoraCollabRefundParams,
  type SatoraOnchainLock,
  sendSatoraOnchainRefund,
  signAndRelaySatoraCollabRefund,
  validateSatoraCollabRefundParams,
} from "../../services/swapkit/debug/SatoraCollabRefundService";
import type { DebugSatoraRefundProps } from "../../types/debug";

type Props = DebugSatoraRefundProps;

/** TEMPORARY — delete together with the service once the refund has settled. */
export default function DebugSatoraRefundModal({ visible, onClose }: Props) {
  const [eoa, setEoa] = useState<string | null>(null);
  const [rawParams, setRawParams] = useState<string | null>(null);
  const [params, setParams] = useState<SatoraCollabRefundParams | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [lock, setLock] = useState<SatoraOnchainLock | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);
  const [refundTxHash, setRefundTxHash] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setRawParams(null);
    setParams(null);
    setBusy(null);
    setError(null);
    setTxHash(null);
    setLock(null);
    setLockError(null);
    setRefundTxHash(null);
    let cancelled = false;
    void (async () => {
      try {
        const address = await getEthereumAddress();
        if (!cancelled) setEoa(address ?? null);
      } catch {
        if (!cancelled) setEoa(null);
      }
      try {
        const onchain = await loadSatoraOnchainLock();
        if (!cancelled) setLock(onchain);
      } catch (e) {
        if (!cancelled) setLockError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const handleFetch = useCallback(() => {
    void (async () => {
      setBusy("fetching params");
      setError(null);
      setParams(null);
      setRawParams(null);
      try {
        const raw = await fetchSatoraCollabRefundParams();
        setRawParams(JSON.stringify(raw, null, 2));
        setParams(validateSatoraCollabRefundParams(raw));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    })();
  }, []);

  const handleRelay = useCallback(() => {
    if (!params) return;
    void (async () => {
      setError(null);
      try {
        const hash = await signAndRelaySatoraCollabRefund(params, (step) => setBusy(step));
        setTxHash(hash);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    })();
  }, [params]);

  const handleOnchainRefund = useCallback(() => {
    if (!lock) return;
    void (async () => {
      setError(null);
      try {
        const hash = await sendSatoraOnchainRefund(lock, (step) => setBusy(step));
        setRefundTxHash(hash);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    })();
  }, [lock]);

  const handleCopyReport = useCallback(() => {
    void Clipboard.setStringAsync(
      [
        `swap ${SATORA_REFUND_SWAP_ID}`,
        `eoa ${eoa ?? "none"}`,
        `params ${rawParams ?? "not fetched"}`,
        `error ${error ?? "none"}`,
        `tx_hash ${txHash ?? "none"}`,
        `onchain_refund_tx ${refundTxHash ?? "none"}`,
      ].join("\n"),
    );
  }, [eoa, rawParams, error, txHash, refundTxHash]);

  const ownerMatches = (eoa ?? "").toLowerCase() === SATORA_REFUND_OWNER.toLowerCase();
  const timelockSeconds = lock ? Number(lock.timelock) : null;
  const timelockReached = timelockSeconds !== null && Date.now() / 1000 >= timelockSeconds;
  const depositorMatches =
    lock !== null && lock.depositor.toLowerCase() === SATORA_REFUND_OWNER.toLowerCase();

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent">
          <TopbarTrailing>
            <IconButton icon="cross" variant="soft" accessibilityLabel="Close" onPress={onClose} />
          </TopbarTrailing>
        </Topbar>
      </Header>
      <Scroll safeAreaBottom>
        <View direction="column" align="stretch" gap="lg" paddingX="lg" paddingBottom="lg">
          <Text size="lg" emphasis>
            Satora collaborative refund
          </Text>
          <Text size="md">
            Signs the CollabRefund message for the stuck EURC→BTC_ARKADE swap and hands it to
            Satora's relay, which broadcasts it. Returns swapped-back USDC on Arbitrum.
          </Text>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="xs">
            <Text size="sm" mono>
              {`swap ${SATORA_REFUND_SWAP_ID}`}
            </Text>
            <Text size="sm" mono>
              {`eoa ${eoa ?? "—"}`}
            </Text>
            <Text size="sm" mono>
              {ownerMatches ? "owner match ✓" : `owner mismatch — expected ${SATORA_REFUND_OWNER}`}
            </Text>
          </View>

          <Button
            size="lg"
            variant="soft"
            onPress={handleFetch}
            disabled={busy !== null || txHash !== null}
          >
            <ButtonText>1 · Fetch params</ButtonText>
          </Button>

          <Button
            size="lg"
            variant="solid"
            accent="lilac"
            onPress={handleRelay}
            disabled={busy !== null || params === null || txHash !== null || !ownerMatches}
          >
            <ButtonText>2 · Sign &amp; relay</ButtonText>
          </Button>

          {busy ? (
            <View direction="row" align="center" gap="sm">
              <Spinner />
              <Text size="md">{busy}</Text>
            </View>
          ) : null}

          {rawParams ? (
            <View
              variant="soft"
              radius="lg"
              padding="lg"
              direction="column"
              align="stretch"
              gap="xs"
            >
              <Text size="md" emphasis>
                {params ? "Params (validated)" : "Params (rejected)"}
              </Text>
              <Text size="sm" mono>
                {rawParams}
              </Text>
            </View>
          ) : null}

          {error ? (
            <View
              variant="soft"
              radius="lg"
              padding="lg"
              direction="column"
              align="stretch"
              gap="xs"
            >
              <Text size="md" emphasis>
                Failed
              </Text>
              <Text size="sm" mono>
                {error}
              </Text>
            </View>
          ) : null}

          {txHash ? (
            <View
              variant="soft"
              radius="lg"
              padding="lg"
              direction="column"
              align="stretch"
              gap="xs"
            >
              <Text size="md" emphasis>
                Relayed
              </Text>
              <Text size="sm" mono>
                {txHash}
              </Text>
            </View>
          ) : null}

          <Text size="lg" emphasis>
            Refund without Satora
          </Text>
          <Text size="md">
            The coordinator's `refundTo` is permissionless once the timelock expires and always pays
            the recorded depositor. Returns tBTC on Arbitrum, no swap-back.
          </Text>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="xs">
            {lock ? (
              <>
                <Text size="sm" mono>
                  {`amount    ${formatUnits(lock.amount, 18)} tBTC`}
                </Text>
                <Text size="sm" mono>
                  {`token     ${lock.token}`}
                </Text>
                <Text size="sm" mono>
                  {`depositor ${lock.depositor}${depositorMatches ? " ✓" : " — NOT this wallet"}`}
                </Text>
                <Text size="sm" mono>
                  {`timelock  ${new Date(Number(lock.timelock) * 1000).toISOString()}`}
                </Text>
                <Text size="sm" mono>
                  {`gas       ${formatUnits(lock.gasBalance, 18)} ETH`}
                </Text>
                <Text size="sm" mono>
                  {timelockReached
                    ? "timelock expired — refundable now"
                    : "timelock not yet expired"}
                </Text>
              </>
            ) : (
              <Text size="sm" mono>
                {lockError ?? "reading the HTLC from chain…"}
              </Text>
            )}
          </View>

          <Button
            size="lg"
            variant="solid"
            accent="lilac"
            onPress={handleOnchainRefund}
            disabled={
              busy !== null ||
              lock === null ||
              !depositorMatches ||
              !timelockReached ||
              refundTxHash !== null
            }
          >
            <ButtonText>3 · Refund onchain (no Satora)</ButtonText>
          </Button>

          {refundTxHash ? (
            <View
              variant="soft"
              radius="lg"
              padding="lg"
              direction="column"
              align="stretch"
              gap="xs"
            >
              <Text size="md" emphasis>
                Refunded onchain
              </Text>
              <Text size="sm" mono>
                {refundTxHash}
              </Text>
            </View>
          ) : null}

          <Button size="lg" variant="soft" onPress={handleCopyReport}>
            <ButtonText>Copy report</ButtonText>
          </Button>
        </View>
      </Scroll>
    </DsSheetHost>
  );
}
