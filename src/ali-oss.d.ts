declare module "ali-oss" {
  interface AliOssOptions {
    accessKeyId: string;
    accessKeySecret: string;
    endpoint: string;
    bucket: string;
    secure?: boolean;
    region?: string;
    cname?: boolean;
    httpsAgent?: unknown;
    timeout?: number;
    retryMax?: number;
  }

  interface AliOssClient {
    list(options?: Record<string, unknown>): Promise<{ objects?: unknown[]; isTruncated?: boolean; nextMarker?: string }>;
    getStream(name: string, options?: Record<string, unknown>): Promise<{ stream: { destroy?: () => void } | null; res: { status?: number; headers?: Record<string, string> } }>;
  }

  const OSS: new (options: AliOssOptions) => AliOssClient;
  export default OSS;
}
