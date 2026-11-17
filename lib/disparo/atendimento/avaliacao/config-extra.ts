import { z } from "zod";


export function comRespostasExtras(base: unknown, extra: unknown): unknown {
  const b = z.object({ respostas: z.record(z.string(), z.unknown()).default({}) }).passthrough().parse(base);
  return { ...b, respostas: { ...b.respostas, ...z.record(z.string(), z.unknown()).parse(extra) } };
}
