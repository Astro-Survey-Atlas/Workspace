export interface ElasticsearchEndpoint {
  url?: string;
  authorization?: string;
}

/**
 * Normalize an Elasticsearch URL and keep optional URL credentials in memory
 * as an Authorization header instead of sending them in the request URL.
 */
export function parseElasticsearchEndpoint(value: string): ElasticsearchEndpoint {
  let normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) return {};

  let authorization: string | undefined;
  try {
    const parsed = new URL(normalized);
    if (parsed.username || parsed.password) {
      const username = decodeURIComponent(parsed.username);
      const password = decodeURIComponent(parsed.password);
      authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
      parsed.username = "";
      parsed.password = "";
      normalized = parsed.toString().replace(/\/+$/, "");
    }
  } catch {
    // Leave invalid endpoint syntax for the request layer to report.
  }

  return { url: normalized || undefined, ...(authorization ? { authorization } : {}) };
}
