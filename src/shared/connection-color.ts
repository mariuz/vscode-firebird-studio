/**
 * A small, fixed color palette for tagging saved connections (tree icon + status bar), mapped to
 * VS Code's own built-in terminal ANSI theme color ids — no custom `contributes.colors` needed,
 * and every color adapts to the user's theme the same way terminal text does. (VS Code has no
 * "charts.*" theme color group, despite a superficially plausible-sounding name — confirmed
 * against the theme color reference before picking `terminal.ansi*` instead.)
 */

export type ConnectionColor = "red" | "yellow" | "green" | "blue" | "purple";

export const CONNECTION_COLORS: ConnectionColor[] = ["red", "yellow", "green", "blue", "purple"];

const THEME_COLOR_IDS: Record<ConnectionColor, string> = {
  red: "terminal.ansiRed",
  yellow: "terminal.ansiYellow",
  green: "terminal.ansiGreen",
  blue: "terminal.ansiBlue",
  purple: "terminal.ansiMagenta",
};

/** Returns the VS Code theme color id for a connection color, or undefined for "no color". */
export function themeColorIdFor(color: ConnectionColor | undefined): string | undefined {
  return color ? THEME_COLOR_IDS[color] : undefined;
}
