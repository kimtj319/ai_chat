import { useEffect } from "react";
import type { ThemeMode } from "../state/types";

/** Reflect the chosen theme mode onto <html data-theme>, letting CSS handle the rest. */
export function useTheme(theme: ThemeMode): void {
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", theme);
    }
  }, [theme]);
}
