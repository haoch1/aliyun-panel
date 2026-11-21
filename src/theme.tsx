import { Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const key = "aliyun-panel:theme:v1";
const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolved: "light" | "dark";
}>(null!);

function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(key);
    if (value === "light" || value === "dark") return value;
  } catch {
    /* Storage may be unavailable in private browsers. */
  }
  return "system";
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const resolved = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", resolved === "dark" ? "#0a0a0b" : "#fafafa");
    try {
      localStorage.setItem(key, theme);
    } catch {
      /* Theme still works without persistence. */
    }
  }, [theme, resolved]);
  useEffect(() => {
    const listener = (event: StorageEvent) => {
      if (event.key === key) setTheme(savedTheme());
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, []);
  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolved }}>
      {children}
    </ThemeContext.Provider>
  );
}

const themeOptions: [Theme, string, typeof Sun][] = [
  ["light", "浅色", Sun],
  ["system", "自动", Monitor],
  ["dark", "深色", Moon],
];

export function ThemeControl({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useContext(ThemeContext);
  return (
    <div
      className={"theme-switcher" + (compact ? " compact" : "")}
      role="group"
      aria-label="外观主题"
    >
      {themeOptions.map(([value, label, Icon]) => (
        <button
          key={value}
          type="button"
          className={
            "theme-switcher-btn" + (theme === value ? " active" : "")
          }
          aria-pressed={theme === value}
          title={label + "模式"}
          onClick={() => setTheme(value)}
        >
          <Icon size={14} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
