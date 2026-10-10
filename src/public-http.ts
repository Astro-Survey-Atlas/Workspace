import { assertPublicHttpUrl, type RemoteUrlPolicyOptions } from "./remote-url-policy.js";
import { abortable } from "./abortable.js";

/** Follow source redirects explicitly so every destination passes the URL policy. */
export async function fetchPublicHttp(value: string | URL, init: RequestInit,
  options: RemoteUrlPolicyOptions & { fetchImpl?: typeof fetch } = {}): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = init.signal ?? options.signal;
  const policy = { ...options, signal: signal ?? undefined };
  let url = await assertPublicHttpUrl(value, policy);
  let request = { ...init, redirect: "manual" as const };
  for (let hop = 0; hop <= 4; hop++) {
    signal?.throwIfAborted();
    const response = await abortable(fetchImpl(url, request), signal);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await abortable(response.body?.cancel() ?? Promise.resolve(), signal);
    if (!location || hop === 4) throw new Error("源站重定向无效或次数过多");
    const destination = await assertPublicHttpUrl(new URL(location, url), policy);
    const headers = new Headers(request.headers);
    if (url.origin !== destination.origin) {
      headers.delete("Authorization");
      headers.delete("Cookie");
      headers.delete("X-Assets-API-Key");
    }
    if (response.status === 303 && request.method !== "HEAD"
      || [301, 302].includes(response.status) && request.method === "POST") {
      headers.delete("Content-Type");
      request = { ...request, method: "GET", body: undefined, headers };
    } else request = { ...request, headers };
    url = destination;
  }
  throw new Error("源站重定向次数过多");
}
