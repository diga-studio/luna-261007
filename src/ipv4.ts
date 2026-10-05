/** 将点分十进制 IPv4 解析为无符号 32 位整数。非法输入抛错。 */
export function parseIpv4(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    throw new Error(`invalid IPv4 address: ${ip}`);
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      throw new Error(`invalid IPv4 address: ${ip}`);
    }
    const octet = Number(part);
    if (octet > 255) {
      throw new Error(`invalid IPv4 address: ${ip}`);
    }
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** 将 CIDR 解析为 [网络起始, 网络结束]（含），主机位被掩掉。支持 /0 至 /32。 */
export function cidrToRange(cidr: string): [number, number] {
  const slash = cidr.indexOf('/');
  if (slash < 0) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const ip = parseIpv4(cidr.slice(0, slash));
  const prefixStr = cidr.slice(slash + 1);
  if (!/^\d{1,2}$/.test(prefixStr)) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const prefix = Number(prefixStr);
  if (prefix > 32) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  // 用 64 位运算避免 /0 时移位 32 的溢出问题
  const size = Math.pow(2, 32 - prefix);
  const start = Math.floor(ip / size) * size;
  const end = start + size - 1;
  return [start >>> 0, end >>> 0];
}
