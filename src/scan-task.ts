/** Small durable checkpoint. Inventories and scientific evidence live in files. */
export interface ScanTask {
  version: 2;
  relativePath?: string;
  sourceConfigSha256: string;
  traceparent?: string;
  inventoryReady: boolean;
  inventorySha256?: string;
  cursor: number;
  processedFiles: number;
  failedFiles: number;
  pointCount: number;
  totalBytes: number;
  mocBatches: number;
  errors: string[];
}
