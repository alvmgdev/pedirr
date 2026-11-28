/** The colour themes a person can choose; "system" follows the device's setting. */
export const THEMES = ["dark", "light", "system"] as const;
export type ThemeChoice = (typeof THEMES)[number];

const KEY = "pedirr.theme";
const lightQuery = () => window.matchMedia("(prefers-color-scheme: light)");
const isTheme = (value: unknown): value is ThemeChoice => THEMES.includes(value as ThemeChoice);

/** The saved choice, or dark (the default) when there is none or storage is blocked. */
export function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return isTheme(value) ? value : "dark";
  } catch {
    return "dark";
  }
}

/** Saves and applies a choice; public/theme.js applies the saved one before the first paint. */
export function applyTheme(choice: unknown) {
  const theme = isTheme(choice) ? choice : "dark";
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage may be blocked; the theme still applies to this page.
  }
  const light = theme === "light" || (theme === "system" && lightQuery().matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", light ? "#f6f4ef" : "#101014");
}

// With "system", follow the device when it switches between light and dark.
lightQuery().addEventListener("change", () => {
  if (storedTheme() === "system") {
    applyTheme("system");
  }
});
