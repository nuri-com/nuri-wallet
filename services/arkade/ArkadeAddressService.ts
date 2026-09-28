import { getOrCreateWallet } from "./internal/walletCache";

/** Returns this wallet's Arkade receive address without exposing the SDK at import time. */
export async function getArkadeReceiveAddress(): Promise<string> {
  const address = String((await (await getOrCreateWallet()).getAddress()) || "").trim();
  if (!address) throw new Error("Could not get Arkade receive address.");
  return address;
}

/** Returns the wallet's on-chain Bitcoin boarding address. */
export async function getArkadeBoardingAddress(): Promise<string> {
  const address = String((await (await getOrCreateWallet()).getBoardingAddress()) || "").trim();
  if (!address) throw new Error("Could not get Bitcoin boarding address.");
  return address;
}
