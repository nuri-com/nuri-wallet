# Passkey PRF — the one invariant that must never break

Every Nuri key is derived from a single WebAuthn PRF value: the bitcoin key,
the ethereum key, the nostr identity, the arkade client signer. The PRF is a
pure function of three inputs:

| input | value | where |
|---|---|---|
| credential | the user's wallet passkey | Google Password Manager / iCloud Keychain |
| rpId | `nuri.com` | `config/passkey.ts` |
| salt | `nuri-prf-salt-v1` | `config/constants.ts` |

Move any of them and every existing user derives a **different** wallet on
their next sign-in. The funds stay on chain; the app can no longer reach them;
there is no recovery, because the old PRF is not reproducible once the inputs
have changed.

`services/auth/PasskeyPrfDerivation.test.ts` pins the inputs and the byte
pass-through. **A failure there is never "update the expected value."** It
means the change under review would strand existing wallets.

## What unit tests cannot see

The PRF itself comes from the browser and the platform authenticator. A unit
test can only prove that *our* code feeds the right inputs and does not mangle
the bytes. Whether a given browser still returns the same PRF for the same
credential is a platform property — it must be measured on a real device.

**Re-run the device check below whenever you touch
`services/auth/PasskeyNativeModuleService.web.ts`, the PRF salt, the RP ID, or
the passkey ceremonies.** It takes about five minutes.

## Device check

Serve the branch on a `*.nuri.com` origin (so the rpId `nuri.com` applies and
the arkade origin allow-list accepts the client — `passkey.nuri.com` is in the
list), open it on the device, and run three ceremonies against one credential:

1. `navigator.credentials.create(...)` with
   `extensions: { prf: { eval: { first: utf8("nuri-prf-salt-v1") } } }` and
   `rp.id = "nuri.com"`. Record `getClientExtensionResults().prf.results.first`.
2. `navigator.credentials.get(...)` with the same rpId and salt, selecting the
   same credential. Record the PRF.
3. Repeat step 2 once more.

All three values must be byte-identical. Anything else is a release blocker.

Last measured 2026-09-17, Android 15 / Chrome 153 / Galaxy S21, on
`passkey.nuri.com`, credential `q8Ae7wF4-oRpJg0LKNABqg`:

```
create()  → 4yP23r…<redacted>
get() #1  → 4yP23r…<redacted>   MATCHES_CREATE: true
get() #2  → 4yP23r…<redacted>   MATCHES_CREATE: true, MATCHES_RUN1: true
```

An earlier independent run on the same device, different credential, matched
the same way (`WXeVMq…<redacted>` from both `create()`
and `get()`).

That equality is what allows `createWalletPasskey` to use the PRF returned by
`create()` instead of firing a second ceremony — see the incident report in
`docs/postmortems/2026-09-17-android-passkey-hang.md` for why the second ceremony
had to go.

## Setting up a test origin

```bash
npx expo export --platform web --output-dir web-build-cf --clear   # APP_NETWORK=mainnet
rsync -a --delete --exclude='*.test.ts' web-build-cf/ cloudflare/assets/
npx wrangler dev --port 8081 --ip 127.0.0.1                        # from cloudflare/
cloudflared tunnel run --url http://localhost:8081 nuri-local-pwa-test
cloudflared tunnel route dns --overwrite-dns nuri-local-pwa-test passkey.nuri.com
```

`passkey.nuri.com` was an unused vhost on the old box (A record
`116.203.208.144`, serving 404); restore that A record when you are done.
Origins the arkade co-signer accepts, as of 2026-09-17: `nuri.com`,
`passkey.nuri.com`, `confirm.nuri.com`, `arkade.nuri.com`, `pwa.nuri.com`,
`pwa2.nuri.com`, `app.nuri.com`, `banking.nuri.com`, `wirex.nuri.com`,
`connect.nuri.com`, `agentchat.nuri.com`, `apptest.nuri.com`. A client origin
outside that list gets `http_401 auth failed: origin mismatch` — that is a
server-side allow-list, not an app bug.
