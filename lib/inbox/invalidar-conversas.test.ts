import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { invalidarConversasAgrupado } from "./invalidar-conversas";

describe("invalidarConversasAgrupado", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("junta uma rajada de eventos em UMA invalidação, dentro da janela", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    for (let i = 0; i < 10; i++) invalidarConversasAgrupado(qc, 1000);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["conversations"] });
  });

  it("evento depois da janela abre outra janela", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    invalidarConversasAgrupado(qc, 1000);
    vi.advanceTimersByTime(1000);
    invalidarConversasAgrupado(qc, 1000);
    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("clients diferentes não se misturam", () => {
    const a = new QueryClient();
    const b = new QueryClient();
    const sa = vi.spyOn(a, "invalidateQueries");
    const sb = vi.spyOn(b, "invalidateQueries");
    invalidarConversasAgrupado(a, 500);
    vi.advanceTimersByTime(500);
    expect(sa).toHaveBeenCalledTimes(1);
    expect(sb).not.toHaveBeenCalled();
  });
});
