import { useState, useEffect } from "react";
import { getNetworkStatus, onNetworkStatusChange } from "../services/app/NetworkStatusService";

export function useNetworkStatus(): boolean {
  const [isWaitingForNetwork, setIsWaitingForNetwork] = useState(
    () => getNetworkStatus().isWaitingForNetwork,
  );

  useEffect(() => {
    const off = onNetworkStatusChange((next) => {
      setIsWaitingForNetwork(next.isWaitingForNetwork);
    });
    return off;
  }, []);

  return isWaitingForNetwork;
}
