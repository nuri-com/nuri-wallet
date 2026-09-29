const DEFAULT_ARKADE_SIGNER_URL = "https://arkade.nuri.com/v4";
import { resetArkadeBoardingMinimumSats } from "./internal/boardingMinimum";

const DEFAULT_ARKADE_NODE_URL = "https://arkade.computer";

type ArkadeConfigSnapshot = {
  signerUrl: string;
  nodeUrl: string;
};

class ArkadeServerConfigService {
  private customSignerUrl: string | null = null;
  private customNodeUrl: string | null = null;
  private subscribers: Set<(snapshot: ArkadeConfigSnapshot) => void> = new Set();

  getSignerServerUrl(): string {
    return this.customSignerUrl || DEFAULT_ARKADE_SIGNER_URL;
  }

  getArkadeNodeUrl(): string {
    return this.customNodeUrl || DEFAULT_ARKADE_NODE_URL;
  }

  getDefaults(): { signerUrl: string; nodeUrl: string } {
    return {
      signerUrl: DEFAULT_ARKADE_SIGNER_URL,
      nodeUrl: DEFAULT_ARKADE_NODE_URL,
    };
  }

  setCustomSignerServerUrl(url: string | null): void {
    const next = typeof url === "string" ? url.trim() : "";
    this.customSignerUrl = next ? next.replace(/\/+$/, "") : null;
    console.log(`🔐 [ArkadeServerConfig.setSigner] url=${this.getSignerServerUrl()}`);
    this.emit();
  }

  setCustomArkadeNodeUrl(url: string | null): void {
    // The floor comes from the node in use, so a switch invalidates it.
    resetArkadeBoardingMinimumSats();
    const next = typeof url === "string" ? url.trim() : "";
    this.customNodeUrl = next ? next.replace(/\/+$/, "") : null;
    console.log(`🔐 [ArkadeServerConfig.setNode] url=${this.getArkadeNodeUrl()}`);
    this.emit();
  }

  reset(): void {
    this.customSignerUrl = null;
    this.customNodeUrl = null;
    resetArkadeBoardingMinimumSats();
    console.log(
      `🔐 [ArkadeServerConfig.reset] signer=${this.getSignerServerUrl()} node=${this.getArkadeNodeUrl()}`,
    );
    this.emit();
  }

  subscribe(callback: (snapshot: ArkadeConfigSnapshot) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private emit(): void {
    const snapshot: ArkadeConfigSnapshot = {
      signerUrl: this.getSignerServerUrl(),
      nodeUrl: this.getArkadeNodeUrl(),
    };
    this.subscribers.forEach((cb) => cb(snapshot));
  }
}

export const arkadeServerConfigService = new ArkadeServerConfigService();
