import { existsSync } from "node:fs";

/**
 * `grep` e `bash` para testes que os chamam por `execFileSync`.
 *
 * No Windows o Node não acha `grep` (ele vive em `usr/bin` do Git for Windows,
 * fora do PATH do processo) e o `bash` pode ser outro que não o do Git. Em
 * Linux/macOS/CI devolve o nome puro e nada muda.
 */
function acharNoGit(exe: string, padrao: string): string {
  if (process.platform !== "win32") return padrao;
  const raizes = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], "C:\Program Files"];
  for (const raiz of raizes) {
    if (!raiz) continue;
    for (const sub of ["usr\bin", "bin"]) {
      const caminho = `${raiz}\Git\${sub}\${exe}.exe`;
      if (existsSync(caminho)) return caminho;
    }
  }
  return padrao;
}

export const GREP = acharNoGit("grep", "grep");
export const BASH = acharNoGit("bash", "bash");
