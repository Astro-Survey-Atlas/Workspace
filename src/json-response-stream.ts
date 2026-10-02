export interface JsonResponseEvent { event: string; value: Record<string, unknown> }

/** A request-scoped reader; events and results are never cached or persisted. */
export async function readJsonResponse<T>(response: Response, update?: (event: JsonResponseEvent) => void, maximumEventBytes = 32 * 1024 * 1024): Promise<T> {
  const streamed = response.headers.get("Content-Type")?.includes("text/event-stream");
  if (!response.body) throw new Error("Query response is unavailable");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      received += chunk.value?.byteLength ?? 0;
      if (received > maximumEventBytes * (streamed ? 8 : 1)) throw new Error("Query response exceeded its transfer budget");
      buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\r\n/g, "\n");
      if (buffer.length > maximumEventBytes) throw new Error("Query event exceeded its size budget");
      if (!streamed) { if (chunk.done) return JSON.parse(buffer) as T; continue; }
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const lines = buffer.slice(0, boundary).split("\n"); buffer = buffer.slice(boundary + 2);
        const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim() ?? "message";
        const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const value = JSON.parse(data) as Record<string, unknown>;
        if (event === "error") throw new Error(String(value.error ?? "Query failed"));
        if (event === "complete") return value as T;
        update?.({ event, value });
      }
      if (chunk.done) throw new Error("Query stream ended before completion");
    }
  } finally { await reader.cancel().catch(() => undefined); }
}
