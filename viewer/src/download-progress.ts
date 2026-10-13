import type { CoverageDownloadJob } from "./api";
import { notifyWorkspace } from "./notifications";

const phases: Record<string, string> = { queued: "排队中", resuming: "恢复断点", downloading: "下载中", verifying: "校验中", registering: "登记中",
  paused: "已暂停", waiting_network: "等待网络恢复", retrying: "等待重试", completed: "全部完成", partial: "部分完成", failed: "失败", cancelled: "已取消" };
function bytes(value: number): string {
  if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(2)} GiB`;
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MiB`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

export function downloadProgress(job: CoverageDownloadJob, action?: (id: string, action: "pause" | "resume" | "retry") => Promise<void>): HTMLElement {
  const card = document.createElement("section"); card.className = "download-progress-card"; card.dataset.downloadJobId = job.id;
  const heading = document.createElement("header");
  const title = document.createElement("strong"); title.textContent = phases[job.phase] ?? job.phase;
  const count = document.createElement("span"); count.textContent = `${job.downloadedFiles}/${job.totalFiles} 已校验`;
  heading.append(title, count); card.append(heading);
  const summary = document.createElement("p"); summary.textContent = `已保存 ${bytes(job.downloadedBytes)} / ${bytes(job.totalBytes)} · ${job.engine === "aria2" ? "独立下载服务" : "历史下载任务"}`;
  card.append(summary);
  for (const file of job.transfer ?? []) {
    const row = document.createElement("article"); row.className = "download-file-progress";
    const name = document.createElement("strong"); name.textContent = file.name; name.title = file.name;
    const meter = document.createElement("progress"); meter.max = file.expectedSizeBytes || Math.max(1, file.bytesPresent); meter.value = file.bytesPresent;
    meter.setAttribute("aria-label", `${file.name} 已保存 ${bytes(file.bytesPresent)}`);
    const detail = document.createElement("small");
    const state = file.status === "verified" ? "已校验" : file.status === "failed" ? "失败，断点已保留" : file.engineState === "verifying" ? "校验中" : phases[job.phase] ?? "排队中";
    detail.textContent = `${state} · ${bytes(file.bytesPresent)}${file.expectedSizeBytes ? ` / ${bytes(file.expectedSizeBytes)}` : ""}`
      + (file.speedBytesPerSecond ? ` · ${bytes(file.speedBytesPerSecond)}/s` : "")
      + (file.etaSeconds !== undefined ? ` · 预计 ${Math.ceil(file.etaSeconds / 60)} 分钟` : "")
      + (file.retryCount ? ` · 已重试 ${file.retryCount} 次` : "");
    row.append(name, meter, detail);
    if (file.lastProgressAt) { const time = document.createElement("small"); time.textContent = `最近进展：${new Date(file.lastProgressAt).toLocaleString()}`; row.append(time); }
    if (file.error) { const reason = document.createElement("small"); reason.className = "download-transfer-error"; reason.textContent = `${file.lastErrorCode ? `${file.lastErrorCode} · ` : ""}${file.error}`; row.append(reason); }
    card.append(row);
  }
  if (action && job.status !== "completed") {
    const controls = document.createElement("div"); controls.className = "settings-record-actions";
    const actions: Array<["pause" | "resume" | "retry", string]> = job.phase === "paused" ? [["resume", "继续下载"]]
      : ["partial", "failed", "cancelled"].includes(job.status) ? [["retry", "重试未完成文件"]] : [["pause", "暂停下载"]];
    for (const [kind, label] of actions) {
      const button = document.createElement("button"); button.type = "button"; button.className = "command-button secondary"; button.textContent = label;
      button.addEventListener("click", () => {
        button.disabled = true;
        void action(job.id, kind).catch(error => notifyWorkspace("下载操作失败", error instanceof Error ? error.message : String(error), { tone: "error" }))
          .finally(() => { button.disabled = false; });
      }); controls.append(button);
    }
    card.append(controls);
  }
  return card;
}
