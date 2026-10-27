import type { CumulativeDataAmount, DataAmount } from "../../src/data-statistics-types.js";

export function formatDataBytes(amount: DataAmount | CumulativeDataAmount | undefined): string {
  if (!amount || amount.state === "unknown") return "未统计";
  if (amount.state === "unsupported") return "不支持";
  const bytes = BigInt(amount.bytes ?? amount.knownBytes);
  const units = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
  let divisor = 1n, unit = 0;
  while (bytes >= divisor * 1000n && unit < units.length - 1) { divisor *= 1000n; unit++; }
  const hundredths = (bytes * 100n + divisor / 2n) / divisor;
  const number = unit ? `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}` : bytes.toString();
  return `${amount.state === "partial" ? "至少 " : ""}${number} ${units[unit]}`;
}

export function formatDataFiles(amount: DataAmount | CumulativeDataAmount): string {
  if (amount.state === "unknown") return "文件数尚未统计";
  if (amount.state === "unsupported") return "不支持统计";
  return `${amount.state === "partial" ? "已统计 " : ""}${amount.files.toLocaleString()} 个文件`;
}
