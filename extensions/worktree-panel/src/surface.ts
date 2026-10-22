import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, foregroundAnsi, parseColor, colorToRgb, indexedColor, mixColors, rgbColor } from "@earendil-works/pi-tui";

// Explicit opaque surfaces: still distinct when Pi uses terminal-default backgrounds.
const palette = {
  body: parseColor("#11161e"), header: parseColor("#202c3a"), selected: parseColor("#293e56"),
  added: parseColor("#142a21"), removed: parseColor("#301d25"),
  text: parseColor("#dce4ee"), muted: parseColor("#acbacb"), dim: parseColor("#9baabd"),
  accent: parseColor("#91c5ff"), border: parseColor("#71869f"), borderAccent: parseColor("#91c5ff"),
  success: parseColor("#8ed6a4"), error: parseColor("#f49baf"), warning: parseColor("#e8cb8b"),
};
export type SurfaceTone = "body" | "header" | "selected" | "added" | "removed";
type Ink = "text" | "muted" | "dim" | "accent" | "border" | "borderAccent" | "success" | "error" | "warning";

export function darkSurface(theme: Theme) {
  const mode = theme.getColorMode();
  const fg = foregroundAnsi(palette.text, mode);
  return {
    fg: (ink: Ink, text: string, bold = false) => theme.style(text, { fg: palette[ink], bold }),
    fill(text: string, tone: SurfaceTone = "body") {
      const bg = backgroundAnsi(palette[tone], mode);
      // Wrapped/highlighted text can contain resets. Restore the opaque surface,
      // not the terminal's default colors, throughout the padded row.
      const restored = text.replace(/\x1b\[(?:0)?m/g, reset => reset + fg + bg)
        .replace(/\x1b\[((?:(?:22|23|24|25|27|28|29|39|49);)*(?:39|49))m/g,
          (reset, params: string) => reset + (params.split(";").includes("39") ? fg : "")
            + (params.split(";").includes("49") ? bg : ""));
      return theme.style(restored, { fg: palette.text, bg: palette[tone] });
    },
  };
}

function luminance(r: number, g: number, b: number) {
  const linear = (v: number) => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** A light Pi theme may emit dark syntax colors; lift those for this dark surface. */
export function readableSyntax(text: string, theme: Theme): string {
  return text.replace(/\x1b\[38;(?:2;(\d+);(\d+);(\d+)|5;(\d+))m/g, (ansi, r, g, b, index) => {
    const color = index === undefined ? rgbColor(Number(r), Number(g), Number(b)) : indexedColor(Number(index));
    const rgb = colorToRgb(color);
    if (luminance(rgb.r, rgb.g, rgb.b) >= 0.3) return ansi;
    for (let amount = 0.1; amount <= 1.01; amount += 0.1) {
      const brighter = mixColors(color, rgbColor(255, 255, 255), Math.min(1, amount), "srgb");
      const value = colorToRgb(brighter);
      if (luminance(value.r, value.g, value.b) >= 0.3) return foregroundAnsi(brighter, theme.getColorMode());
    }
    return foregroundAnsi(palette.text, theme.getColorMode());
  });
}
