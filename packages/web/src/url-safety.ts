import type { UrlSafetyResult } from "./types.js";

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }

  return octets;
}

function isPrivateOrLocalIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets;
  if (a === 0 && b === 0 && octets[2] === 0 && octets[3] === 0) {
    return true;
  }
  if (a === 127) {
    return true;
  }
  if (a === 10) {
    return true;
  }
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  return false;
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function parseIpv4MappedIpv6(addr: string): number[] | null {
  const lower = addr.toLowerCase();
  const dottedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (dottedMatch !== null) {
    return parseIpv4(dottedMatch[1]!);
  }

  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMatch !== null) {
    const high = Number.parseInt(hexMatch[1]!, 16);
    const low = Number.parseInt(hexMatch[2]!, 16);
    return [
      (high >> 8) & 0xff,
      high & 0xff,
      (low >> 8) & 0xff,
      low & 0xff,
    ];
  }

  return null;
}

function isUnsafeIpv6(addr: string): string | null {
  const lower = stripIpv6Brackets(addr).toLowerCase();

  if (!lower.includes(":")) {
    return null;
  }

  const mappedIpv4 = parseIpv4MappedIpv6(lower);
  if (mappedIpv4 !== null && isPrivateOrLocalIpv4(mappedIpv4)) {
    return "private or local IP address is not allowed";
  }

  const firstHextet = lower.split(":")[0];
  if (firstHextet === undefined || firstHextet.length === 0) {
    return null;
  }

  const value = Number.parseInt(firstHextet, 16);
  if (Number.isNaN(value)) {
    return null;
  }

  // fc00::/7 — unique local addresses
  if ((value & 0xfe00) === 0xfc00) {
    return "private IPv6 address is not allowed";
  }

  // fe80::/10 — link-local addresses
  if ((value & 0xffc0) === 0xfe80) {
    return "link-local IPv6 address is not allowed";
  }

  return null;
}

function isUnsafeHostname(hostname: string): string | null {
  const lower = hostname.toLowerCase();

  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return "localhost is not allowed";
  }

  if (lower === "::1" || lower === "[::1]") {
    return "loopback IPv6 address is not allowed";
  }

  const ipv4Host = stripIpv6Brackets(lower);
  const octets = parseIpv4(ipv4Host);
  if (octets !== null && isPrivateOrLocalIpv4(octets)) {
    return "private or local IP address is not allowed";
  }

  const ipv6Reason = isUnsafeIpv6(lower);
  if (ipv6Reason !== null) {
    return ipv6Reason;
  }

  return null;
}

export function assertSafeHttpUrl(raw: string): UrlSafetyResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "only http and https URLs are allowed" };
  }

  const hostnameReason = isUnsafeHostname(parsed.hostname);
  if (hostnameReason !== null) {
    return { ok: false, reason: hostnameReason };
  }

  return { ok: true, href: parsed.href };
}
