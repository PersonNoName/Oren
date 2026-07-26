/** Redact likely secrets from log/error strings before printing. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "sk-***")
    .replace(/\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, "$1***")
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET)[A-Z0-9_]*)\s*[:=]\s*([^\s,;]+)/gi, "$1=***");
}
