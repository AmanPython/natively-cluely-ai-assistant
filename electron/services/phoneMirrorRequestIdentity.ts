/** True for IPv4/IPv6 loopback remote addresses. */
export function isLoopbackAddress(addr: string): boolean {
  if (!addr) return false;
  // Node may report IPv4-mapped IPv6 (::ffff:127.0.0.1) or bare ::1 / 127.x.
  return (
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.startsWith('127.') ||
    addr.startsWith('::ffff:127.')
  );
}

/**
 * Who is really on the other end. A Cloudflare tunnel (Phone Mirror → Internet)
 * dials this server from 127.0.0.1, so the socket address alone makes an
 * internet visitor look like a local process. Cloudflare's edge always adds
 * Cf-Connecting-Ip / Cf-Ray and a client cannot strip them, so their presence
 * marks a request as proxied: it must never receive loopback-only powers
 * (/pair, /dom, the extension role) and is rate-limited per real client IP
 * instead of sharing the loopback bucket with the extension and the owner.
 * Local browsers and the extension never send these headers.
 */
export function requestIdentity(
  remoteAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): { ip: string; viaProxy: boolean; loopback: boolean } {
  const remote = remoteAddress || '0.0.0.0';
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || '';
  const cfIp = first(headers['cf-connecting-ip']).trim();
  const viaProxy =
    !!cfIp || !!first(headers['cf-ray']) || !!first(headers['x-forwarded-for']) || !!first(headers['cf-visitor']);
  const loopback = isLoopbackAddress(remote) && !viaProxy;
  return { ip: viaProxy ? `proxy:${cfIp || first(headers['x-forwarded-for']).split(',')[0].trim() || 'unknown'}` : remote, viaProxy, loopback };
}
