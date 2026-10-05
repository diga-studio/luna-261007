/** 解析 "a.b.c.d" 为 32 位无符号整数。非法输入抛错。 */
export function parseIpv4(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    throw new Error(`invalid IPv4 address: ${ip}`);
  }
  let value = 0;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3 || !/^\d+$/.test(part)) {
      throw new Error(`invalid IPv4 address: ${ip}`);
    }
    const octet = Number(part);
    if (octet > 255 || (part.length > 1 && part.charCodeAt(0) === 48)) {
      throw new Error(`invalid IPv4 address: ${ip}`);
    }
    value = value * 256 + octet;
  }
  return value;
}

/**
 * 解析 CIDR（前缀 0..32）为 [网络地址, 广播地址] 闭区间（32 位无符号整数）。
 * CIDR 中的主机位被忽略，按掩码归一化。
 */
export function cidrToRange(cidr: string): readonly [number, number] {
  const slash = cidr.indexOf('/');
  if (slash < 0) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const address = parseIpv4(cidr.slice(0, slash));
  const prefixText = cidr.slice(slash + 1);
  if (!/^\d{1,2}$/.test(prefixText)) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const prefix = Number(prefixText);
  if (prefix > 32) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  // 用乘法规避 JS 位运算的负数问题，结果保持无符号。
  const blockSize = 2 ** (32 - prefix);
  const network = Math.floor(address / blockSize) * blockSize;
  return [network, network + blockSize - 1];
}
