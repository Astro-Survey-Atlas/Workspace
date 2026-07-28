export const BUILTIN_TAGS = [
    { id: "catalog", label: "星表", category: "modality", origin: "builtin" },
    { id: "imaging", label: "成像", category: "modality", origin: "builtin" },
    { id: "photometry", label: "测光", category: "modality", origin: "builtin" },
    { id: "spectroscopy", label: "光谱", category: "modality", origin: "builtin" },
    { id: "ultraviolet", label: "紫外", category: "modality", origin: "builtin" },
    { id: "infrared", label: "红外", category: "modality", origin: "builtin" },
    { id: "integral-field", label: "积分视场", category: "modality", origin: "builtin" },
    { id: "time-domain", label: "时域", category: "modality", origin: "builtin" },
    { id: "cube", label: "数据立方", category: "modality", origin: "builtin" },
    { id: "timeseries", label: "时序", category: "modality", origin: "builtin" },
    { id: "fits", label: "FITS", category: "format", origin: "builtin" },
    { id: "parquet", label: "Parquet", category: "format", origin: "builtin" },
    { id: "crossmatch", label: "交叉匹配", category: "workflow", origin: "builtin" },
    { id: "cutout", label: "Cutout", category: "workflow", origin: "builtin" },
    { id: "package", label: "打包", category: "workflow", origin: "builtin" },
];
export function listTags() {
    return BUILTIN_TAGS.map((tag) => structuredClone(tag));
}
