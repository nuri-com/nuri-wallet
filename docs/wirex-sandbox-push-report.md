# Wirex Sandbox Push-to-Card Debug Report

This report documents the Wirex sandbox debugging path that ended in a successful end-to-end CLI push-to-card run. It focuses on the things we got wrong, why those mistakes happened, how they blocked progress, and how each issue was fixed.

## Final working state

1. Sandbox auth works against `https://api-baas.wirexapp.tech`.
2. The local debug server and the `dev.nuri.com/tunnel/18791` proxy path are healthy.
3. User lookup, KYC state reads, bank account reads, card reads, and recipient reuse work.
4. Sandbox mint works with correct raw units.
5. Wirex wallet balance sync works after mint.
6. Push-to-card estimate and execution work.
7. The last successful live CLI push used EOA `0x61Bc7fc747619c7B4B3891577461860f7D9dF44D`, Wirex smart wallet `0xfe8858121297B3e048C4deEC4cF89116ecD9Ab08`, external card id `366a9829-a345-4428-8b38-ab0c16da9b36`, estimation id `c1c2ff9c-a476-4325-84c4-9eb41c047df9`, and transfer id `0c11cf71-e81e-40bc-bf15-bbf7e650af27`.

## Blockers, mistakes, fixes

1. **We hit the wrong Wirex environment host.** We initially pointed sandbox token exchange at `api-baas.wirexapp.com` instead of `api-baas.wirexapp.tech`. That made a valid sandbox credential set look invalid. We did this because we treated the host as an implementation detail and assumed the same base host would work across environments. The fix was to switch the Wirex base URL to `.tech` in the server, env, and helper paths. The proof was a `200` token exchange against the sandbox host.

2. **We confused a bad environment call with bad credentials.** After calling the wrong host, we interpreted the `401` response as a Wirex credential problem. That delayed the real diagnosis because we blamed credentials before proving the environment selection was correct. The fix was to validate the host first, then re-run the token exchange. Once the host was corrected, auth succeeded.

3. **We treated the public tunnel as healthy before proving the full path.** The app-side proxy path returned `502` at multiple points. We initially spent time on Wirex-side theories while the public route itself was unhealthy. We did this because we verified local server health before verifying the public `dev.nuri.com` path that the app actually uses. The fix was to restore the reverse tunnel and re-check `https://dev.nuri.com/tunnel/18791/health` directly. That removed the proxy as a variable.

4. **We were missing or misusing proxy authentication on the app-facing debug path.** The client needed to send the proxy auth header consistently for the dev tunnel. We did this wrong because the local server path did not need that auth, so the failure only appeared on the shared dev ingress path. The fix was to build and send the Basic auth header from the client debug helpers and use the same header during proxy health checks.

5. **We kept identifying the Wirex user with the wrong header after user creation.** Follow-up requests were sending `X-User-Address`, while Wirex expected `X-User-Id`, `X-User-Wallet`, or `X-User-Email`. This blocked `get_user`, KYC, cards, recipients, and bank-account follow-up steps. We did this wrong because older integration code still assumed the address header was accepted everywhere. The fix was to switch the post-create request path to Wirex’s accepted user identifier headers. Once that changed, `get_user` and the downstream account reads started working again.

6. **We treated repeat onboarding state as a failure instead of a valid already-provisioned state.** `kyc_link` and `kyc_token` returning `User is already verified` were not the real blockers once the user was already approved. We did this wrong because the debug flow was optimized for first-time onboarding and treated later `400` responses as hard failures even when they described a satisfied prerequisite. The fix was to read current user state first and interpret `already verified`, `existing card`, and `capability does not need activation` responses as state, not root errors.

7. **We kept trying sandbox sharing-token paths even after Wirex said sharing was unsupported.** This added noise and made the logs look more broken than they really were. We did this wrong because the fallback logic handled user creation but still attempted later sharing-related calls. The fix was to short-circuit sharing in the sandbox debug flow after `sharing_not_supported` and stop treating missing sharing as the primary blocker.

8. **We sent the wrong PCI tokenization field name.** The tokenization request used `name_on_card`, while the Wirex PCI endpoint required `cardholder_name`. This blocked card tokenization before recipient creation could even happen. We did this wrong because we reused our own internal naming instead of matching the PCI contract exactly. The fix was to send `cardholder_name`.

9. **We parsed the PCI tokenization response incorrectly.** After fixing the request shape, tokenization still looked broken because the endpoint returned the tokenized id in `value`, but our parser only looked for `tokenized_card_id`-style fields. We did this wrong because we assumed the response would mirror our preferred field names. The fix was to accept `value` as the tokenized card id. After that, recipient creation could proceed.

10. **We returned the wrong external card id after recipient creation.** We initially propagated the payment-details id instead of the actual `card.card_id`. That made later push-to-card calls point at the wrong identifier even after recipient creation succeeded. We did this wrong because the payload contains two similar-looking ids and we picked the easier nested one instead of the id Wirex expects for card transfer. The fix was to return and reuse `card.card_id`.

11. **We misunderstood the push-to-card funding model.** We initially treated the card number as both destination and funding context, which made token selection look optional or secondary. In Wirex’s model, the card is the destination, but the source is a specific supported token in the Wirex wallet. We did this wrong because we blurred recipient creation with transfer funding. The fix was to separate the two stages cleanly: create or resolve card recipient first, then quote and execute with a concrete token address.

12. **We guessed token addresses from the wrong source.** We tried repo token lists and public testnet assets before grounding the flow in Wirex’s sandbox token set. This blocked estimate and execution because Wirex only accepts its supported sandbox tokens for that environment. We did this wrong because the repo had token registries that looked relevant but did not describe Wirex’s sandbox balance model. The fix was to use Wirex-supported sandbox token addresses and, later, to read the wallet token set from Wirex itself.

13. **We assumed public Circle Base Sepolia `EURC` was the same asset as Wirex sandbox `EURC`.** It was not. We successfully put public Circle `EURC` onchain and then spent time wondering why Wirex did not reflect it. We did this wrong because both assets shared the symbol `EURC`, but they were different contracts with different roles in the sandbox flow. The fix was to stop treating symbol equality as contract equality and align all testing with Wirex’s own sandbox token contracts.

14. **We blamed Wirex balance sync before proving our onchain units were correct.** This was the most important mistake. We hardcoded `WEUR`, `WUSD`, and `USDT` as `6`-decimals tokens, but the live contracts are `18` decimals. That made the mint helper send dust while our formatter reported it as whole units. We did this wrong because we generalized from `USDC` and `EURC` being `6` decimals and did not verify each contract with `decimals()`. The fix was to correct the decimals map and recompute both raw mint amounts and onchain formatting. After this change, `WEUR` mint `5` became `5000000000000000000` instead of `5000000`, the false `36 -> 41` view became the correct dust view `0.000000000036 -> 0.000000000041`, and minting `5` finally produced `WEUR.balance = 5` in Wirex wallet.

15. **We trusted our own debug summaries too early.** The summary reason `funded_onchain_waiting_for_wirex_balance` was sometimes wrong because it depended on the same bad decimals map used by the formatter and mint helper. We did this wrong because we treated a derived debug explanation as stronger evidence than raw values. The fix was to compare raw onchain balances, contract decimals, Wirex wallet balances, estimate payloads, and execute results together before deciding what the blocker was.

16. **We did not verify contract metadata early enough.** The single fastest proof in this entire path was a direct `eth_call` to `decimals()`. We should have done that before building any balance conclusions. We did this wrong because the debugging flow drifted toward business APIs first and contract metadata second. The fix was to verify token contracts directly with public RPC whenever a unit-sensitive path was involved.

17. **We considered exporting a private key, but that would have been the wrong tool for this problem.** The successful fix required no raw private key at all. We did this wrong conceptually because the problem looked like a blockchain ownership issue when it was actually a server-side unit bug plus API contract mismatches. The fix was to keep validation on the safe path: public RPC for chain reads, Wirex APIs for user/wallet/transfer state, and the existing debug server for orchestration. No private key export was needed.

## Why the API is still required even when blockchain is available

1. Blockchain is authoritative for token balances in the smart wallet.
2. Wirex is authoritative for user provisioning, wallet interpretation, recipient creation, quotes, and card-network payout execution.
3. Push-to-card is not a pure onchain transfer. It is an off-ramp into card rails.
4. The correct mental model is that RPC proves the wallet balance and token contract facts, while Wirex API proves whether that user, wallet, recipient, and token are usable in the payout product.
5. The main mistake was not using the API. The main mistake was using the API while feeding it the wrong units and, earlier, the wrong request shapes and identifiers.

## Files that mattered most

1. The Wirex proxy server (`server-wirex/index.js`, now in the nuri-servers repo) contained nearly all critical integration bugs and final fixes.
2. `lib/wirex/createUser.ts` controlled proxy auth and all app-to-debug-server calls.
3. `screens/DebugWirexSignUpModal.tsx` exposed the state machine, summaries, and manual debug controls that made the issues visible.
4. `lib/wirex/summaryBuilding.ts` and `lib/wirex/stageFormatting.ts` shaped the diagnostics and made the final state easier to understand.

## Practical takeaways for future work

1. Verify environment host before judging credentials.
2. Verify public ingress before judging backend logic.
3. Verify user identifier headers before judging resource availability.
4. Verify request and response field names against the live endpoint, not assumed schema symmetry.
5. Verify contract `decimals()` before building mint math, balance formatters, or threshold checks.
6. Do not infer asset compatibility from token symbols alone.
7. Do not export private keys for server-side integration debugging when public RPC plus product APIs are enough.
