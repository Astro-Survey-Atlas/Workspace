/** Stable categorical colors used when a survey record has no usable color. */
const FALLBACK_SURVEY_COLORS = [
  "#e15759",
  "#f28e2b",
  "#59a14f",
  "#b279a2",
  "#4e79a7",
  "#edc948",
  "#76b7b2",
  "#ff9da7",
  "#9c755f",
  "#af7aa1",
  "#2f8f9d",
  "#d37295",
] as const;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const GENERIC_SURVEY_COLORS = new Set(["#376b9b", "#82979e"]);

function srgbToLinear(value: number): number {
  return value < 0.04045 ? value * 0.0773993808 : Math.pow(value * 0.9478672986 + 0.0521327014, 2.4);
}

function linearToSrgb(value: number): number {
  return value < 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 0.41666) - 0.055;
}

export function fallbackSurveyColor(surveyId: string): string {
  let hash = 2166136261;
  for (const character of surveyId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return FALLBACK_SURVEY_COLORS[(hash >>> 0) % FALLBACK_SURVEY_COLORS.length]!;
}

/** Normalize the catalog color while preventing generic server fallbacks from
 * making every unclassified survey look like the same blue layer. */
export function surveyColorFor(surveyId: string, source?: string): string {
  const color = source?.trim().toLowerCase();
  return color && HEX_COLOR.test(color) && !GENERIC_SURVEY_COLORS.has(color)
    ? color
    : fallbackSurveyColor(surveyId);
}

/** Match the sky renderer's higher-contrast display color in CSS/UI chrome. */
export function surveyDisplayColor(surveyId: string, source?: string): string {
  const color = surveyColorFor(surveyId, source);
  const channels = [
    srgbToLinear(Number.parseInt(color.slice(1, 3), 16) / 255),
    srgbToLinear(Number.parseInt(color.slice(3, 5), 16) / 255),
    srgbToLinear(Number.parseInt(color.slice(5, 7), 16) / 255),
  ];
  const max = Math.max(...channels);
  const min = Math.min(...channels);
  const delta = max - min;
  let hue = 0;
  let saturation = 0;
  const lightness = (min + max) / 2;
  if (delta > 0) {
    saturation = lightness <= 0.5 ? delta / (max + min) : delta / (2 - max - min);
    switch (max) {
      case channels[0]: hue = (channels[1]! - channels[2]!) / delta + (channels[1]! < channels[2]! ? 6 : 0); break;
      case channels[1]: hue = (channels[2]! - channels[0]!) / delta + 2; break;
      default: hue = (channels[0]! - channels[1]!) / delta + 4; break;
    }
    hue /= 6;
  }
  saturation = Math.min(0.94, Math.max(0.78, saturation));
  const displayLightness = 0.42;
  const p = displayLightness <= 0.5 ? displayLightness * (1 + saturation) : displayLightness + saturation - displayLightness * saturation;
  const q = 2 * displayLightness - p;
  const hueToRgb = (value: number): number => {
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return q + (p - q) * 6 * value;
    if (value < 1 / 2) return p;
    if (value < 2 / 3) return q + (p - q) * 6 * (2 / 3 - value);
    return q;
  };
  const display = [hueToRgb(hue + 1 / 3), hueToRgb(hue), hueToRgb(hue - 1 / 3)];
  return `#${display.map((channel) => Math.round(Math.max(0, Math.min(1, linearToSrgb(channel))) * 255).toString(16).padStart(2, "0")).join("")}`;
}
