import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "@/lib/theme";

function Atual() { const { theme, resolvedTheme } = useTheme(); return <span>{theme}:{resolvedTheme}</span>; }
afterEach(() => { cleanup(); localStorage.clear(); });
it("usa escuro sem preferência mesmo com sistema claro", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  render(<ThemeProvider><Atual /></ThemeProvider>);
  expect(screen.getByText("dark:dark")).toBeTruthy();
});
it("respeita preferência clara salva", () => {
  localStorage.setItem("crm-alquimia.theme", "light");
  render(<ThemeProvider><Atual /></ThemeProvider>);
  expect(screen.getByText("light:light")).toBeTruthy();
});
