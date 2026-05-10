import type { Palette } from "./messages";

export const PALETTES: Record<string, Palette> = {
  kirokaze: ["#332c50", "#46878f", "#94e344", "#e2f3e4"],
  dmg: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
  pocket: ["#000000", "#555555", "#aaaaaa", "#ffffff"],
  bgb: ["#081820", "#346856", "#88c070", "#e0f8d0"],
  mist: ["#2d1b00", "#1e606e", "#5ab9a8", "#c4f0c2"],
};

export const DEFAULT_PALETTE_NAME = "kirokaze";

const HEX = /^#[0-9a-fA-F]{6}$/;

export function parseCustomPalette(input: unknown): Palette | null {
  if (!Array.isArray(input) || input.length !== 4) return null;
  if (!input.every((v) => typeof v === "string" && HEX.test(v))) return null;
  return [input[0], input[1], input[2], input[3]] as Palette;
}

export function resolvePalette(
  name: string | undefined,
  custom: unknown
): Palette {
  const fromCustom = parseCustomPalette(custom);
  if (fromCustom) return fromCustom;
  if (name && PALETTES[name]) return PALETTES[name]!;
  return PALETTES[DEFAULT_PALETTE_NAME]!;
}
