# SwapKit — was die App vom Server-Dev braucht / Fragen

Stand 2026-07-13, gegen `swapkit.nuri.com/mcp` live verifiziert.
App-Seite: `services/swapkit/*` (Branch `feat/swapkit-cow-signing`, PR #823).

Die App führt ausschließlich `bestProduction`-Routen aus und deklariert
`walletCapabilities: ["pay_lightning_invoice","sign_and_broadcast_evm_tx","sign_typed_data"]`.

## Blocker / konkrete Bedarfe

1. **EUR-denominierter Input (`amount` + `side`) liefert kaum Routen.**
   Live gemessen:
   - `BTC_LN → EURC_BASE, amount:15, side:"settle"` (exakt 15 € empfangen):
     `bestProduction: null`, options leer — die FixedFloat/CoW/LI.FI-Routen
     erscheinen nur bei `sats`-Input.
   - `EURC_BASE → BTC_LN, amount:15, side:"deposit"` (exakt 15 € ausgeben):
     nur `bitcoinvn-direct`; die CoW-Route fehlt (vermutlich exact-buy-Kontrakt
     braucht fixe sats).
   **Frage:** Ist EUR-seitiger Input für die kuratierten Routen geplant?
   Wenn ja, in beide Richtungen? Bis dahin bleibt die App sats-denominiert.

2. **`requiredGas` — GELIEFERT 2026-07-13.** Der Server liefert Chain,
   Chain-ID, Mindest-Wei und `beforeFunding`; die App liest für assisted
   Base-Routen jetzt diesen Wert statt ihrer alten Gate-Konstante. Fehlende
   oder ungültige Metadaten blockieren vor dem Funding.

3. **Gas-Faucet — GEFIXT 2026-07-13.** Wurzel des "missing ETH on Base"-
   Fehlers war der once-ever-Claim im Faucet-Contract. **BaseFaucet v2
   deployed: `0x7b16aD517f0b1dc0E220d6A3Ff79074Bb9a1021e`** (Cooldown 24 h pro
   Adresse statt einmal-für-immer; PR nuri-com/base-faucet#1, alte
   0x3Ef7…5095 leergezogen, Relay umgestellt, Health grün auf wirex+banking).
   - `no_eure` bleibt (Sybil-Schutz): frische Wallets ohne Token bekommen den
     Drip mid-swap, sobald der Hub USDC/EURC an die EOA geliefert hat.
   - **Pot auffüllen:** 0.0035 ETH (~7 Drips) im Contract, Relayer 0.0012 —
     für echten Betrieb ETH an `0x7b16aD51…021e` senden.
   - Health: `banking.nuri.com/faucet/health`.

3b. **KV-Limits — GELÖST/DEPLOYED 2026-07-13:**
   `KV put() limit exceeded for the day` = die **Free-Tier-Tagesquota
   (1.000 Writes/Tag)** war aufgebraucht → JEDER Swap auf JEDER Route
   scheiterte bei swap_execute bis zum UTC-Mitternacht-Reset. Fix:
   PR nuri-mcp-bitcoin-swapkit#5 wurde übernommen (No-Op-Writes entfallen),
   und jede Transaktion liegt jetzt in einem eigenen SQLite Durable Object.
   KV bleibt nur Sparse-Index und Legacy-Migration. Ursprünglicher Befund:
   **"KV put limit exceeded" (HTTP 200 + isError) erreicht die App.**
   Cloudflare-KV erlaubt 1 Write/Sekunde/Key — bei swap_track-Polling +
   Submit schlägt das durch und ein User-Swap wirkt kaputt, obwohl nur
   ein Rate-Limit griff. Bitte serverseitig: Writes koaleszieren/debouncen
   (oder Durable Object statt KV für heiße Tx-Keys) und das Limit nie als
   Tool-Error an den Client geben. Der Server liefert transiente Fehler nun
   strukturiert als `TEMPORARILY_UNAVAILABLE`; read-only Provider-Calls werden
   begrenzt wiederholt, Mutationen nicht blind wiederholt. `swap_options`
   quotet parallel und cached exakte Ergebnisse kurz (leer/all-failed nie).

## Zusagen / Stabilität

4. **`swap_options`-Shape ist jetzt App-Kontrakt:** `bestProduction`,
   `productionReady`, `releaseStatus`, `requiredCapabilities`, `routeId`.
   Neue Felder nur additiv; nichts umbenennen.
5. **`bestProduction` bleibt die Sicherheitsgrenze:** nur Routen mit
   funded-Mainnet-Beweis UND Recovery-Drill promoten. Die App vertraut
   blind — kein clientseitiges Route-Wissen.
6. **`fund.deadline`/`expiresAt` konsistent auf allen Routen** liefern;
   der Quote-Deadline-Buffer der App greift nur, wenn eine Deadline kommt.

6b. **Direkte Base-Rails — GELIEFERT/MAINNET_PROVEN.** Vier direkte
   USDC-Rails (Satora, Boltz, FixedFloat, BitcoinVN) und zwei native
   Base-ETH-Gas-Rails (FixedFloat, BitcoinVN) sind serverseitig in beide
   Richtungen funded getestet. Die App-Typen kennen `USDC_BASE`/`ETH_BASE`;
   sichtbare Asset-Auswahl und native ETH-Sendelogik bleiben Client-Arbeit.

## App-Recovery

7. **Boltz/Satora — serverseitig ausführen:** Die App importiert keine
   Provider-SDKs und führt keine Provider-State-Machines aus. Bis SwapKit diese
   Routen vollständig serverseitig orchestriert, bleiben sie quote-only.

## Incident 2026-07-13 — Provider-SDKs in Expo

1. **Auswirkung:** Eine lokale, nie committete Satora/Boltz-Implementierung
   brachte Provider-SDKs in Expo. Dadurch wurden `viem` und `ox` aktualisiert;
   Metro folgte Tempo-Imports bis zu `node:worker_threads` und WASM, wodurch das
   iOS-Bundling abbrach. Nichts davon wurde committed, gepusht, per EAS gebaut
   oder als OTA ausgeliefert.
2. **Ursache:** Provider-APIs, State-Machines und Recovery-Orchestrierung lagen
   fälschlich in der Wallet statt im SwapKit-Server.
3. **Korrektur:** Die vier direkten Abhängigkeiten und alle neuen App-Adapter
   wurden entfernt; der committete Dependency-Stand ist wiederhergestellt.
   Das bestehende `@arkade-os/boltz-swap` bleibt für den unabhängigen
   Arkade-Pfad erhalten.
4. **Verbindliche Grenze:** Provider-SDKs und Provider-State-Machines kommen
   ohne separate ausdrückliche Freigabe nicht in Expo. Dieser Incident
   genehmigt weder einen generischen Signer noch eine andere Wallet-Ersetzung.
5. **Verifikation:** 169/169 Tests sowie frische iOS- und Web-Exports bestehen.
   Die entfernten Adapter, `htlc_signing` und die vier entfernten direkten
   Pakete werden im App-Code und in den direkten Dependencies nicht mehr
   referenziert.

## Später (nicht jetzt bauen)

8. **Route-Promotion-Pipeline:** kurze Notiz an uns, wenn eine Route
   promoted/demoted wird — die App zeigt sie automatisch an, aber wir
   wollen Releases/Support darauf einstellen können.
