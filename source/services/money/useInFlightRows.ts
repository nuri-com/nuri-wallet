import { useEffect, useState } from "react";
import { EventBus } from "../events/AppEventBusService";
import { MoneyInFlightStore, type MoneyInFlight, type MoneyRail } from "./MoneyInFlightStore";
import { inFlightRowsFor, type InFlightRow } from "./inFlightRows";

/** Every in-flight record, kept current. */
export function useMoneyInFlight(): MoneyInFlight[] {
  const [records, setRecords] = useState<MoneyInFlight[]>(() => MoneyInFlightStore.list());
  useEffect(() => {
    const read = () => setRecords(MoneyInFlightStore.list());
    void MoneyInFlightStore.hydrate().then(read);
    return EventBus.on(MoneyInFlightStore.CHANGED, read);
  }, []);
  return records;
}

/** The pending rows `rails` draws, kept current. */
export function useInFlightRows(rails: readonly MoneyRail[]): InFlightRow[] {
  const records = useMoneyInFlight();
  return inFlightRowsFor(records, rails);
}
