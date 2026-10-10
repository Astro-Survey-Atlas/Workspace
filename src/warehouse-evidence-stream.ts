import { createReadStream } from "node:fs";
import { Tokenizer, TokenParser, TokenType } from "@streamparser/json";

/** Consume complete rows with bounded parser state; never retain either large array. */
export async function streamWarehouseEvidence(
  filePath: string,
  row: (kind: "files" | "coverage", value: Record<string, unknown>) => void,
  afterChunk?: () => Promise<void>,
): Promise<Record<string, unknown>> {
  const metadata: Record<string, unknown> = {};
  const parser = new TokenParser({ paths: ["$.schemaVersion", "$.phase", "$.scanRunId", "$.layerId", "$.sourceSnapshot", "$.files.*", "$.coverage.*"], keepStack: false });
  parser.onValue = ({ key, value, stack }) => {
    if (stack.length === 1 && typeof key === "string") metadata[key] = value;
    else if (stack.length === 2) {
      const kind = stack[1]?.key;
      if (kind !== "files" && kind !== "coverage") return;
      if (typeof key !== "number" || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Warehouse ${kind} row must be an object`);
      row(kind, value as Record<string, unknown>);
    }
  };
  const tokenizer = new Tokenizer({ stringBufferSize: 64 * 1024, numberBufferSize: 64 });
  let depth = 0;
  let previous: TokenType | undefined;
  let rootKey: string | undefined;
  const keys = new Set<string>();
  tokenizer.onToken = (token) => {
    if (depth === 1 && token.token === TokenType.STRING && (previous === TokenType.LEFT_BRACE || previous === TokenType.COMMA)) {
      rootKey = String(token.value);
      if (keys.has(rootKey)) throw new Error(`Duplicate Warehouse evidence property: ${rootKey}`);
      keys.add(rootKey);
    }
    if (depth === 1 && previous === TokenType.COLON && (rootKey === "files" || rootKey === "coverage") && token.token !== TokenType.LEFT_BRACKET) throw new Error(`Warehouse ${rootKey} must be an array`);
    parser.write(token);
    if (token.token === TokenType.LEFT_BRACE || token.token === TokenType.LEFT_BRACKET) depth++;
    else if (token.token === TokenType.RIGHT_BRACE || token.token === TokenType.RIGHT_BRACKET) depth--;
    previous = token.token;
  };
  // A bounded 1 MiB read avoids thousands of small NFS round trips on old
  // multi-gigabyte evidence while retaining only the current parsed row.
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    tokenizer.write(chunk);
    await afterChunk?.();
  }
  if (!tokenizer.isEnded) tokenizer.end();
  if (!parser.isEnded) parser.end();
  if (depth !== 0) throw new Error("Incomplete Warehouse evidence");
  return metadata;
}
