#!/usr/bin/env node
// Generates a VAPID keypair for Web Push (PWA notifications).
//
// VAPID is not a vendor credential — it is a self-signed ECDSA P-256 keypair
// that identifies our server to the browser's push endpoint. No account, no
// API key, no dependency: node:crypto covers it.
//
//   node scripts/generate-vapid-keys.mjs
//
// Public key  → EXPO_PUBLIC_VAPID_PUBLIC_KEY (inlined into the web bundle,
//               read by services/notifications/NotificationService.web.ts)
// Private key → the sending backend ONLY. It signs push requests; anyone
//               holding it can push to every subscriber. Never commit it,
//               never ship it in the bundle.
//
// Rotating the keypair invalidates every existing subscription — clients have
// to re-subscribe — so generate once and store it properly.

import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const pub = publicKey.export({ format: "jwk" });
const priv = privateKey.export({ format: "jwk" });

const b64uToBytes = (value) => Buffer.from(value, "base64url");

// The Push API wants the uncompressed EC point (0x04 || X || Y), base64url —
// not the JWK or the DER wrapper.
const rawPoint = Buffer.concat([Buffer.from([0x04]), b64uToBytes(pub.x), b64uToBytes(pub.y)]);

console.log("");
console.log("VAPID keypair (P-256)");
console.log("");
console.log(
  "  Public  (app .env):      EXPO_PUBLIC_VAPID_PUBLIC_KEY=%s",
  rawPoint.toString("base64url"),
);
console.log("  Private (backend only):  %s", priv.d);
console.log("");
console.log("The private key never belongs in this repo or in the web bundle.");
console.log("");
