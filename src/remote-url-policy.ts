import { lookup } from "node:dns/promises";
import net from "node:net";

export type RemoteHostnameResolver = (hostname: string) => Promise<readonly string[]>;

export interface RemoteUrlPolicyOptions {
  /** Test and controlled integrations may provide a deterministic resolver. */
  resolveHostname?: RemoteHostnameResolver;
  /** Custom fetch implementations used by isolated tests do not need DNS I/O. */
  skipDnsLookup?: boolean;
}

function ipv4Value(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return undefined;
  return octets.reduce((result, part) => result * 256 + part, 0);
}

function nonPublicIpv4(value: string): boolean {
  const address = ipv4Value(value);
  if (address === undefined) return false;
  const inRange = (start: number, end: number): boolean => address >= start && address <= end;
  return inRange(0x00000000, 0x00ffffff) // unspecified and "this" network
    || inRange(0x0a000000, 0x0affffff) // RFC 1918
    || inRange(0x64400000, 0x647fffff) // carrier-grade NAT
    || inRange(0x7f000000, 0x7fffffff) // loopback
    || inRange(0xa9fe0000, 0xa9feffff) // link-local
    || inRange(0xac100000, 0xac1fffff) // RFC 1918
    || inRange(0xc0000000, 0xc00000ff) // IETF protocol assignments
    || inRange(0xc0000200, 0xc00002ff) // TEST-NET-1
    || inRange(0xc0a80000, 0xc0a8ffff) // RFC 1918
    || inRange(0xc6120000, 0xc613ffff) // benchmarking
    || inRange(0xc6336400, 0xc63364ff) // TEST-NET-2
    || inRange(0xcb007100, 0xcb0071ff) // TEST-NET-3
    || inRange(0xe0000000, 0xffffffff); // multicast and reserved
}

function ipv6Segments(value: string): number[] | undefined {
  const normalized = value.replace(/^\[|\]$/g, "").split("%")[0]?.toLowerCase();
  if (!normalized) return undefined;
  const compression = normalized.indexOf("::");
  if (compression >= 0 && compression !== normalized.lastIndexOf("::")) return undefined;
  const expand = (part: string): number[] | undefined => {
    if (!part) return [];
    const pieces = part.split(":");
    const result: number[] = [];
    for (const piece of pieces) {
      if (piece.includes(".")) {
        const address = ipv4Value(piece);
        if (address === undefined) return undefined;
        result.push((address >>> 16) & 0xffff, address & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(piece)) return undefined;
        result.push(Number.parseInt(piece, 16));
      }
    }
    return result;
  };
  if (compression < 0) {
    const result = expand(normalized);
    return result?.length === 8 ? result : undefined;
  }
  const left = expand(normalized.slice(0, compression));
  const right = expand(normalized.slice(compression + 2));
  if (!left || !right || left.length + right.length >= 8) return undefined;
  return [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right];
}

function nonPublicIpv6(value: string): boolean {
  const segments = ipv6Segments(value);
  if (!segments) return false;
  const first = segments[0] ?? 0;
  const second = segments[1] ?? 0;
  if (segments.every((segment) => segment === 0)) return true;
  if (segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1) return true;
  if ((first & 0xfe00) === 0xfc00) return true; // RFC 4193 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // link-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  const mapped = segments.slice(0, 5).every((segment) => segment === 0) && segments[5] === 0xffff;
  const compatible = segments.slice(0, 6).every((segment) => segment === 0);
  if (mapped || compatible) {
    const address = `${segments[6]! >>> 8}.${segments[6]! & 0xff}.${segments[7]! >>> 8}.${segments[7]! & 0xff}`;
    return nonPublicIpv4(address);
  }
  return false;
}

export function isNonPublicAddress(value: string): boolean {
  const normalized = value.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!normalized) return true;
  if (net.isIP(normalized) === 4) return nonPublicIpv4(normalized);
  if (net.isIP(normalized) === 6) return nonPublicIpv6(normalized);
  return false;
}

function localHostname(hostname: string): boolean {
  const normalized = hostname.trim().replace(/\.$/, "").toLowerCase();
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

async function defaultResolveHostname(hostname: string): Promise<readonly string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

/** Validate an HTTP(S) URL before the server makes an outbound request. */
export async function assertPublicHttpUrl(value: string | URL, options: RemoteUrlPolicyOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new RangeError("Remote URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new RangeError("Remote URL must use HTTP or HTTPS");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (localHostname(hostname) || isNonPublicAddress(hostname)) {
    throw new RangeError("Remote URL must not target a local or private network address");
  }
  if (!options.skipDnsLookup) {
    const resolveHostname = options.resolveHostname ?? defaultResolveHostname;
    try {
      const addresses = await resolveHostname(hostname);
      if (addresses.some((address) => isNonPublicAddress(address))) {
        throw new RangeError("Remote URL resolves to a local or private network address");
      }
    } catch (error) {
      if (error instanceof RangeError && /private|local/i.test(error.message)) throw error;
      // A DNS failure will be reported by fetch. Keeping it as a valid URL
      // avoids turning a transient resolver outage into a permanent catalog
      // rejection, while successful private resolutions remain blocked.
    }
  }
  return url;
}
