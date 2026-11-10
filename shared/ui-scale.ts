export const UI_SCALE_MIN = 75;
export const UI_SCALE_MAX = 150;
export const UI_SCALE_STEP = 5;
export const UI_SCALE_DEFAULT = 100;

/** Clamp saved or user-supplied scale values to the supported slider range. */
export function normalizeUiScale(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return UI_SCALE_DEFAULT;
  const stepped = Math.round(parsed / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, stepped));
}
