import { describe, expect, it } from "vitest";
import { Family, formatCidr, parseCidr } from "../dist/ip.js";

describe("parseCidr", () => {
  it("parses IPv4 CIDRs across the full prefix range", () => {
    expect(parseCidr("0.0.0.0/0")).toEqual({ family: Family.V4, network: 0n, prefixLen: 0 });
    expect(parseCidr("255.255.255.255/32")).toEqual({
      family: Family.V4,
      network: 0xffffffffn,
      prefixLen: 32,
    });
    expect(parseCidr("192.168.1.0/24")).toEqual({
      family: Family.V4,
      network: 0xc0a80100n,
      prefixLen: 24,
    });
  });

  it("zeroes non-zero host bits", () => {
    expect(parseCidr("10.1.2.3/8").network).toBe(0x0a000000n);
    expect(parseCidr("2001:db8::dead:beef/32").network).toBe(
      0x20010db8000000000000000000000000n,
    );
  });

  it("parses IPv6 including compressed and IPv4-mapped forms", () => {
    expect(parseCidr("::/0")).toEqual({ family: Family.V6, network: 0n, prefixLen: 0 });
    expect(parseCidr("::1/128").network).toBe(1n);
    expect(parseCidr("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128").network).toBe(
      (1n << 128n) - 1n,
    );
    // IPv4-mapped IPv6 stays in the IPv6 space.
    const mapped = parseCidr("::ffff:10.0.0.0/104");
    expect(mapped.family).toBe(Family.V6);
    expect(mapped.network).toBe(0xffff0a000000n);
    expect(parseCidr("1:2:3:4:5:6:1.2.3.4/128").network).toBe(
      (0x0001000200030004n << 64n) | (0x0005000601020304n),
    );
  });

  it("rejects malformed input", () => {
    expect(() => parseCidr("10.0.0.0")).toThrow();
    expect(() => parseCidr("10.0.0.0/33")).toThrow();
    expect(() => parseCidr("::/129")).toThrow();
    expect(() => parseCidr("1::2::3/64")).toThrow();
    expect(() => parseCidr("10.0.0.256/8")).toThrow();
  });
});

describe("formatCidr", () => {
  it("round-trips normalized CIDRs", () => {
    const cases = [
      "0.0.0.0/0",
      "10.0.0.0/8",
      "255.255.255.255/32",
      "::/0",
      "::1/128",
      "2001:db8::/32",
      "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128",
      "::ffff:a00:0/104",
    ];
    for (const text of cases) {
      const parsed = parseCidr(text);
      expect(formatCidr(parsed.family, parsed.network, parsed.prefixLen)).toBe(text);
    }
  });

  it("compresses the longest zero run, first run wins ties", () => {
    expect(formatCidr(Family.V6, 0x20010db8000000000000000000000001n, 128)).toBe(
      "2001:db8::1/128",
    );
    expect(formatCidr(Family.V6, 0x20010000200200000003000000040000n, 128)).toBe(
      "2001:0:2002:0:3:0:4:0/128",
    );
  });
});
