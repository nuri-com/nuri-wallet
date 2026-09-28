#!/usr/bin/env node
//
// Safety check for the Arkade VHTLC refund path (SwapKitArkadeVhtlcService).
//
// Rebuilds each VHTLC script from the server's public parameters and asserts it
// hashes to exactly the address that was funded. That equality is what the
// refund adapter relies on before its key signs anything: one wrong key, hash
// or timelock and it must fail closed.
//
// The fixtures are the two swaps that stranded 62,000 sats on 2026-07-18, when
// satora went silent after funding. Public swap material only — no secrets.
// Lives here rather than in vitest because vitest cannot transform
// @arkade-os/sdk (the same reason the app imports it dynamically).
//
// Run: node scripts/vhtlc-refund-check.mjs

import assert from "node:assert/strict";
import { VHTLC } from "@arkade-os/sdk";
import { hex } from "@scure/base";
const xo = (h) => {
  const b = hex.decode(h.replace(/^0x/, ""));
  return b.length === 33 ? b.slice(1) : b;
};
const rel = (n) => ({ type: n >= 512 ? "seconds" : "blocks", value: BigInt(n) });

const cases = [
  {
    name: "sk_9db090f4 (42000 sats)",
    expect:
      "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamec2vvc5xfm5y5wltla4pq6u7phk256d2v40v6epud9lz7ker9twgp9p6vxx",
    v: {
      hashLock: "0xb116db2a718d010872229944fdc2213c3a29ebf4",
      senderPublicKey: "0350606dddd1be64f1bc528cbba7593b647b3b8d0c21f1b97aca1f7df2c31f8306",
      receiverPublicKey: "031eddc2ea766eb46bb582d10964ff15b7ed8247b61cbc398802b0180d4b57ef8b",
      arkadeServerPublicKey: "038202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779c",
      refundLocktime: 1784471181,
      unilateralClaimDelay: 605184,
      unilateralRefundDelay: 778240,
      unilateralRefundWithoutReceiverDelay: 778240,
    },
  },
  {
    name: "sk_597681b7 (20000 sats)",
    expect:
      "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjameeqd8qsn0han4q5se55ksclvvrfr2ck8h9sj86jclk7wdg6f8dwhspuzqrc",
    v: {
      hashLock: "0x357245d2f2915098ac62294a27c0e24ff912bf71",
      senderPublicKey: "02c569ed6a58d1090a04261ed1aa3a524064bae28e7e45ad79eb9b669d8224db70",
      receiverPublicKey: "0346539259062cd3433de664f3e3c99b3cdc81e609e08c051a8bd61c0c45f08658",
      arkadeServerPublicKey: "038202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779c",
      refundLocktime: 1784471072,
      unilateralClaimDelay: 605184,
      unilateralRefundDelay: 778240,
      unilateralRefundWithoutReceiverDelay: 778240,
    },
  },
];

for (const c of cases) {
  const server = xo(c.v.arkadeServerPublicKey);
  const s = new VHTLC.Script({
    sender: xo(c.v.senderPublicKey),
    receiver: xo(c.v.receiverPublicKey),
    server,
    preimageHash: hex.decode(c.v.hashLock.replace(/^0x/, "")),
    refundLocktime: BigInt(c.v.refundLocktime),
    unilateralClaimDelay: rel(c.v.unilateralClaimDelay),
    unilateralRefundDelay: rel(c.v.unilateralRefundDelay),
    unilateralRefundWithoutReceiverDelay: rel(c.v.unilateralRefundWithoutReceiverDelay),
  });
  assert.equal(
    s.address("ark", server).encode(),
    c.expect,
    `${c.name}: rebuilt VHTLC address must equal the funded address`,
  );

  // The leaf that makes a refund possible without the provider: CLTV over
  // [sender, server] only, so a silent receiver cannot block it.
  assert.ok(s.refundWithoutReceiver(), `${c.name}: refundWithoutReceiver leaf must exist`);

  // Any single wrong parameter must change the address (fail closed).
  const tampered = new VHTLC.Script({
    sender: xo(c.v.senderPublicKey),
    receiver: xo(c.v.receiverPublicKey),
    server,
    preimageHash: hex.decode(c.v.hashLock.replace(/^0x/, "")),
    refundLocktime: BigInt(c.v.refundLocktime + 1),
    unilateralClaimDelay: rel(c.v.unilateralClaimDelay),
    unilateralRefundDelay: rel(c.v.unilateralRefundDelay),
    unilateralRefundWithoutReceiverDelay: rel(c.v.unilateralRefundWithoutReceiverDelay),
  });
  assert.notEqual(
    tampered.address("ark", server).encode(),
    c.expect,
    `${c.name}: a changed locktime must change the address`,
  );

  console.log(`✅ ${c.name} — address verified, refundWithoutReceiver present, tampering detected`);
}

console.log("✅ VHTLC refund self-check passed (address equality · refund leaf · fail-closed)");
