// The SSRF guard of the LNURL forwarder that runs on the PWA box
// (docs/server/lnurl-proxy.js, deployed to /opt/lnurl-proxy/server.js). The
// endpoint takes a caller-supplied URL, so every non-public form it fails to
// recognise is a route to a service behind the box.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { isBlockedIp, parseTarget } = require("./lnurl-proxy.js") as {
  isBlockedIp: (ip: string) => boolean;
  parseTarget: (raw: string) => URL;
};

describe("isBlockedIp", () => {
  it("blocks private and loopback IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "224.0.0.1",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "192.169.0.1", "99.99.99.99"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("blocks every address in fe80::/10, not just the fe80 prefix", () => {
    for (const ip of ["fe80::1", "fe90::1", "fea0::1", "febf::1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("blocks loopback, ULA, multicast and unspecified IPv6", () => {
    for (const ip of ["::", "::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1%eth0"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("blocks IPv4-mapped addresses written in hex, not only dotted", () => {
    for (const ip of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1", // 127.0.0.1
      "::ffff:0a00:1", // 10.0.0.1
      "::ffff:a9fe:a9fe", // 169.254.169.254
      "::ffff:c0a8:1", // 192.168.0.1
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows IPv4-mapped public addresses", () => {
    expect(isBlockedIp("::ffff:1.1.1.1")).toBe(false);
    expect(isBlockedIp("::ffff:0101:0101")).toBe(false);
  });

  it("allows global unicast IPv6", () => {
    for (const ip of ["2001:4860:4860::8888", "2606:4700:4700::1111", "3fff::1"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("blocks IPv4-compatible and other reserved IPv6 outside 2000::/3", () => {
    for (const ip of ["::7f00:1", "0064:ff9b::7f00:1", "4000::1", "1000::1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("blocks anything unparseable", () => {
    for (const ip of ["", "not-an-ip", "12345::::1", "fe80::1::2"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });
});

describe("parseTarget", () => {
  it("accepts https", () => {
    expect(parseTarget("https://cake.cash/.well-known/lnurlp/nuri").hostname).toBe("cake.cash");
  });

  it("rejects other schemes and embedded credentials", () => {
    expect(() => parseTarget("http://example.com/")).toThrow();
    expect(() => parseTarget("file:///etc/passwd")).toThrow();
    expect(() => parseTarget("https://user:pass@example.com/")).toThrow();
  });
});
