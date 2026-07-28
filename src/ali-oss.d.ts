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
  }

  const OSS: new (options: AliOssOptions) => AliOssClient;
  export default OSS;
}
