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

function isUnsafeHostname(hostname: string): string | null {
  const lower = hostname.toLowerCase();

  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return "localhost is not allowed";
  }

  if (lower === "::1" || lower === "[::1]") {
    return "loopback IPv6 address is not allowed";
  }

  const ipv4Host = lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
  const octets = parseIpv4(ipv4Host);
  if (octets !== null && isPrivateOrLocalIpv4(octets)) {
    return "private or local IP address is not allowed";
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
