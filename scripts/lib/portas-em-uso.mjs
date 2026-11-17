// Uso: node scripts/lib/portas-em-uso.mjs PORTA [PORTA...]
// Imprime, uma por linha, as portas que o instalador NÃO pode usar nesta máquina. Não imprime nada se
// todas estiverem livres. Chamado por scripts/lib/instalar-env.sh e instalar-env.ps1 (o Node já é
// exigido pelo instalador, e assim o .sh e o .ps1 conferem do mesmo jeito em Linux, Mac e Windows).
//
// Uma porta está em uso quando:
//   - alguém ATENDE nela em 127.0.0.1 ou ::1 (outro app, outro Supabase, o Docker publicando para outro
//     projeto). É o caso perigoso: no Windows, ligar 127.0.0.1:PORTA pode dar certo mesmo com outro
//     programa em 0.0.0.0:PORTA, e o tráfego local passaria a cair no lugar errado sem erro nenhum;
//   - ou não dá para ligar nela em 127.0.0.1 (ocupada, ou numa faixa reservada pelo sistema).
// Só abre e fecha conexões locais: não manda nada e não escuta em interface de rede.

import net from "node:net";

function atende(host, porta) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: porta });
    const fim = (sim) => {
      s.destroy();
      resolve(sim);
    };
    s.setTimeout(1500, () => fim(false));
    s.once("connect", () => fim(true));
    s.once("error", () => fim(false));
  });
}

function ligaLocal(porta) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ host: "127.0.0.1", port: porta, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

(async () => {
  const ocupadas = [];
  for (const arg of process.argv.slice(2)) {
    const porta = Number(arg);
    if (!Number.isInteger(porta) || porta < 1 || porta > 65535) continue;
    const emUso = (await atende("127.0.0.1", porta)) || (await atende("::1", porta)) || !(await ligaLocal(porta));
    if (emUso) ocupadas.push(porta);
  }
  if (ocupadas.length > 0) process.stdout.write(ocupadas.join("\n") + "\n");
})();
