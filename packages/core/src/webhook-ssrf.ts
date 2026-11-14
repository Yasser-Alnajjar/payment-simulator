import { BlockList, isIP } from "node:net";

/**
 * SSRF rules for user-configured webhook URLs (pure; the sender applies them to every DNS answer before connecting).
 *
 * Address policy is allowlist-first:
 *  - IPv4 must be outside every special-purpose block below.
 *  - IPv6 must be inside 2000::/3 (global unicast) and outside the special blocks listed. Everything else (::, ::1, IPv4-mapped and
 *    IPv4-compatible forms, NAT64, ULA, link-local, site-local, multicast, discard) is outside 2000::/3 and therefore refused.
 * The URL is parsed with the WHATWG parser first, which normalizes numeric IPv4 tricks (2130706433, 0x7f.1, 0177.0.0.1, 127.1)
 * to dotted form and IDNs to punycode, so the checks see the canonical host.
 */
const V4_BLOCKED: ReadonlyArray<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const V6_GLOBAL: ReadonlyArray<[string, number]> = [["2000::", 3]];
const V6_BLOCKED_IN_GLOBAL: ReadonlyArray<[string, number]> = [
  ["2001::", 23], // IETF protocol assignments incl. Teredo 2001::/32 and ORCHID
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds arbitrary IPv4)
  ["3fff::", 20], // documentation (RFC 9637)
];

const v4Blocked = new BlockList();
for (const [a, p] of V4_BLOCKED) v4Blocked.addSubnet(a, p, "ipv4");
v4Blocked.addAddress("255.255.255.255", "ipv4");
const v6Global = new BlockList();
for (const [a, p] of V6_GLOBAL) v6Global.addSubnet(a, p, "ipv6");
const v6Blocked = new BlockList();
for (const [a, p] of V6_BLOCKED_IN_GLOBAL) v6Blocked.addSubnet(a, p, "ipv6");

/** True when the address must never be contacted from a hosted deployment. Unparseable input counts as blocked. */
export function isBlockedAddress(address: string): boolean {
  if (address.includes("%")) return true; // zone ids only exist for link-local scopes
  const v = isIP(address);
  if (v === 4) return v4Blocked.check(address, "ipv4");
  if (v === 6) return !v6Global.check(address, "ipv6") || v6Blocked.check(address, "ipv6");
  return true;
}

export const WEBHOOK_URL_MAX = 2048;
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".home.arpa", ".lan", ".corp", ".localdomain"];
const BLOCKED_NAMES = new Set(["localhost", "localhost.localdomain", "metadata", "metadata.google.internal"]);

export type UrlRejection = "invalid_url" | "url_too_long" | "scheme_not_allowed" | "credentials_in_url" | "fragment_not_allowed" | "port_not_allowed" | "host_not_allowed" | "private_address";

export interface ValidatedTarget {
  url: URL;
  /** Lower-case host without brackets or trailing dot (punycode for IDNs). */
  host: string;
  port: number;
  /** Set when the host is an IP literal (then no DNS lookup happens). */
  ipLiteral: string | null;
}

/**
 * Validates a webhook URL. `allowPrivate` exists only for local development (http, localhost and private addresses); the server
 * enables it solely when APP_ENV=development and ALLOW_PRIVATE_WEBHOOK_TARGETS=true, and tests inject it directly.
 */
export function validateWebhookUrl(raw: string, opts: { allowPrivate?: boolean } = {}): { ok: true; target: ValidatedTarget } | { ok: false; code: UrlRejection; message: string } {
  const allowPrivate = opts.allowPrivate === true;
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, code: "invalid_url", message: "url must be an absolute URL" };
  if (raw.length > WEBHOOK_URL_MAX) return { ok: false, code: "url_too_long", message: `url must be at most ${WEBHOOK_URL_MAX} characters` };
  if (/[\u0000- \u007f]/.test(raw)) return { ok: false, code: "invalid_url", message: "url must not contain whitespace or control characters" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, code: "invalid_url", message: "url must be an absolute URL" };
  }
  if (!(u.protocol === "https:" || (allowPrivate && u.protocol === "http:"))) return { ok: false, code: "scheme_not_allowed", message: "url must use https" };
  if (u.username || u.password) return { ok: false, code: "credentials_in_url", message: "url must not contain credentials" };
  if (u.hash || raw.includes("#")) return { ok: false, code: "fragment_not_allowed", message: "url must not contain a fragment" };

  const port = u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port);
  const portOk = allowPrivate ? port >= 1 && port <= 65535 : port === 443 || port === 80 || (port >= 1024 && port <= 65535);
  if (!portOk) return { ok: false, code: "port_not_allowed", message: "url port must be 443, 80 or 1024-65535" };

  let host = u.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.length > 253) return { ok: false, code: "host_not_allowed", message: "url host is not allowed" };

  if (isIP(host)) {
    if (!allowPrivate && isBlockedAddress(host)) return { ok: false, code: "private_address", message: "url must not point to a private, loopback, link-local or reserved address" };
    return { ok: true, target: { url: u, host, port, ipLiteral: host } };
  }
  if (!allowPrivate) {
    if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, code: "host_not_allowed", message: "url host is not allowed" };
    if (!host.includes(".")) return { ok: false, code: "host_not_allowed", message: "url host must be a fully qualified domain name" };
    if (/^[0-9.]+$/.test(host)) return { ok: false, code: "invalid_url", message: "url host is not a valid domain name" };
  }
  return { ok: true, target: { url: u, host, port, ipLiteral: null } };
}
