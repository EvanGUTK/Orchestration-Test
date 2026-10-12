/**
 * Same-origin checks for state-changing requests (ACC-04) and WebSocket upgrades.
 *
 *  - Host must be a loopback name (127.0.0.1, localhost, [::1]); when `allowedHosts` is configured
 *    it must be one of those exact host:port values. This defeats DNS-rebinding.
 *  - When `Origin` is present it must equal `<protocol>://<Host>` exactly (scheme, host and port).
 *    `Origin: null` and foreign origins are rejected.
 *  - When `Origin` is absent, the Host match above is the check (non-browser local clients).
 *  - `Sec-Fetch-Site: cross-site | same-site` is rejected when present.
 */
export type OriginPolicy = { allowedHosts: readonly string[] | null };

export type OriginVerdict = { ok: true } | { ok: false; reason: string };

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;

export function checkHost(host: string | undefined, policy: OriginPolicy): OriginVerdict {
  if (!host) return { ok: false, reason: "missing Host header" };
  const normalized = host.toLowerCase();
  if (!LOOPBACK_HOST.test(normalized)) return { ok: false, reason: "Host is not a loopback address" };
  if (policy.allowedHosts && !policy.allowedHosts.includes(normalized)) {
    return { ok: false, reason: "Host is not served by this application" };
  }
  return { ok: true };
}

export function checkSameOrigin(
  headers: { host?: string | undefined; origin?: string | undefined; secFetchSite?: string | undefined },
  protocol: "http" | "https",
  policy: OriginPolicy,
): OriginVerdict {
  const host = checkHost(headers.host, policy);
  if (!host.ok) return host;
  const site = headers.secFetchSite?.toLowerCase();
  if (site === "cross-site" || site === "same-site") return { ok: false, reason: "cross-site request" };
  if (headers.origin === undefined) return { ok: true };
  const expected = `${protocol}://${(headers.host as string).toLowerCase()}`;
  if (headers.origin.toLowerCase() !== expected) return { ok: false, reason: "foreign Origin" };
  return { ok: true };
}

/** Default allowed hosts for a server on `port` (plus the dev web port that proxies to it). */
export function loopbackHostsFor(ports: readonly number[]): string[] {
  const hosts: string[] = [];
  for (const port of ports) hosts.push(`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`);
  return hosts;
}
