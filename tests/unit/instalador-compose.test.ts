/**
 * O `docker-compose.yml` da instalação local de um comando.
 *
 * Testes ESTÁTICOS (leem o arquivo; não sobem Docker): a prova de execução é a instalação numa
 * pasta limpa. Aqui se trancam as coisas que, erradas, não dão erro nenhum e só aparecem como
 * "o WhatsApp responde com horas de atraso" ou "as mensagens do celular nunca chegam":
 *   1. a Evolution fica TRAVADA no digest para o qual o patch do Baileys foi feito;
 *   2. o patch está montado, somente leitura, no caminho certo da imagem;
 *   3. o webhook global assina exatamente os eventos que o CRM consome.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EVENTOS_DO_WEBHOOK } from "@/lib/channels/evolution/client";

const RAIZ = process.cwd();
const compose = readFileSync(join(RAIZ, "docker-compose.yml"), "utf8");

const DIGEST_DA_EVOLUTION = "sha256:966625532d9076a2381e973a271307d107e6f070450de3abeeea8bd18be07252";

/** O compose sem as linhas de comentário inteiro (os comentários citam coisas que NÃO devem estar no código). */
const codigo = compose
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

describe("docker-compose.yml: Evolution travada e com patch", () => {
  it("a imagem da Evolution é referenciada pelo digest travado, não por tag", () => {
    expect(codigo).toContain(`image: evoapicloud/evolution-api@${DIGEST_DA_EVOLUTION}`);
    expect(codigo).not.toMatch(/evoapicloud\/evolution-api:/);
  });

  it("o patch do Baileys está montado somente leitura no messages-recv.js da imagem", () => {
    expect(codigo).toContain(
      "./docker/evolution/baileys-messages-recv.js:/evolution/node_modules/baileys/lib/Socket/messages-recv.js:ro",
    );
  });

  it("o arquivo do patch existe e traz o handler da stanza <status>", () => {
    const patch = readFileSync(join(RAIZ, "docker/evolution/baileys-messages-recv.js"), "utf8");
    expect(patch).toContain("PATCH LOCAL");
    expect(patch).toContain("ws.on('CB:status'");
    expect(existsSync(join(RAIZ, "docker/evolution/LEIA-ME.md"))).toBe(true);
  });

  it("o LEIA-ME da Evolution cita o mesmo digest do compose", () => {
    const leiaMe = readFileSync(join(RAIZ, "docker/evolution/LEIA-ME.md"), "utf8");
    expect(leiaMe).toContain(DIGEST_DA_EVOLUTION);
  });
});

describe("docker-compose.yml: webhook global da Evolution", () => {
  it("liga o webhook global e aponta para a rota que o app já tem", () => {
    expect(codigo).toContain('WEBHOOK_GLOBAL_ENABLED: "true"');
    const url = /WEBHOOK_GLOBAL_URL: (\S+)/.exec(codigo)?.[1] ?? "";
    expect(url.startsWith("http://app:3000/api/v1/webhooks/evolution/")).toBe(true);
    // o segredo vem do .env.local, nunca escrito no arquivo
    expect(url).toContain("${EVOLUTION_WEBHOOK_TOKEN");
    expect(existsSync(join(RAIZ, "app/api/v1/webhooks/evolution/[token]/route.ts"))).toBe(true);
  });

  it("os eventos ligados são EXATAMENTE a lista EVENTOS_DO_WEBHOOK do app", () => {
    const ligados = [...codigo.matchAll(/WEBHOOK_EVENTS_([A-Z_]+): "true"/g)].map((m) => m[1]!).sort();
    expect(ligados).toEqual([...EVENTOS_DO_WEBHOOK].sort());
  });

  it("a lista cobre os eventos novos (mensagem do celular, edição, exclusão e ligação)", () => {
    for (const evento of ["SEND_MESSAGE", "MESSAGES_EDITED", "MESSAGES_DELETE", "CALL"]) {
      expect(codigo).toContain(`WEBHOOK_EVENTS_${evento}: "true"`);
    }
  });
});

describe("docker-compose.yml: imagens de terceiros travadas por digest", () => {
  it("toda imagem que não é construída aqui traz @sha256", () => {
    const imagens = [...codigo.matchAll(/^\s+image: (\S+)/gm)].map((m) => m[1]!);
    const deTerceiros = imagens.filter((i) => !i.startsWith("crm-alquimia-"));
    expect(deTerceiros.length).toBeGreaterThanOrEqual(4); // redis, srh, evolution-db, evolution
    for (const imagem of deTerceiros) expect(imagem, imagem).toMatch(/@sha256:[0-9a-f]{64}$/);
  });
});

describe("docker-compose.yml: serviços da instalação local", () => {
  const servicos = ["app", "worker", "scheduler", "evolution", "evolution-db", "redis", "srh"];

  it.each(servicos)("declara o serviço %s", (nome) => {
    expect(codigo).toMatch(new RegExp(`^  ${nome}:\\s*$`, "m"));
  });

  it("app, worker e scheduler são construídos do código desta pasta", () => {
    expect(codigo).toMatch(/dockerfile: Dockerfile\s*$/m);
    expect(codigo).toContain("dockerfile: Dockerfile.worker");
    expect(codigo).toContain("dockerfile: Dockerfile.scheduler");
    for (const arquivo of ["Dockerfile", "Dockerfile.worker", "Dockerfile.scheduler", "docker/scheduler/entrypoint.sh"]) {
      expect(existsSync(join(RAIZ, arquivo)), arquivo).toBe(true);
    }
  });

  it("não depende do kit de VPS do projeto original (removido nesta versão)", () => {
    expect(codigo).not.toMatch(/setup-kit|traefik|caddy|ghcr\.io|docker-compose\.prod|docker-compose\.build/i);
  });

  it("só publica porta em 127.0.0.1 (nada fica aberto para a rede)", () => {
    const portas = [...codigo.matchAll(/^\s+- "([^"]+:\d+)"\s*$/gm)].map((m) => m[1]!);
    expect(portas.length).toBeGreaterThan(0);
    for (const p of portas) expect(p.startsWith("127.0.0.1:"), p).toBe(true);
  });

  it("as portas do host são configuráveis por CRM_ALQUIMIA_PORTA_*", () => {
    for (const v of ["CRM_ALQUIMIA_PORTA_APP", "CRM_ALQUIMIA_PORTA_WORKER", "CRM_ALQUIMIA_PORTA_EVOLUTION"]) {
      expect(codigo).toContain("${" + v + ":-");
    }
  });

  it("o envio real NÃO é ligado pelo compose (sem DISPARO_REAL_LIBERADO)", () => {
    expect(codigo).not.toContain("DISPARO_REAL_LIBERADO");
  });

  it("segredos vêm do ambiente e faltar um falha alto, sem valor padrão escrito", () => {
    for (const v of ["INTERNAL_SECRET", "SRH_TOKEN", "EVOLUTION_DB_PASSWORD", "EVOLUTION_API_KEY", "EVOLUTION_WEBHOOK_TOKEN"]) {
      expect(codigo, v).toContain("${" + v + ":?");
    }
    expect(codigo).not.toMatch(/crm_dev|changeme|change_me/i);
  });

  it("o nome do projeto do compose é crm-alquimia", () => {
    expect(codigo).toMatch(/^name: crm-alquimia$/m);
  });
});

describe("o redis não deixa volume anônimo órfão", () => {
  // A imagem do redis declara `VOLUME /data`. Sem nada montado ali, cada `up` depois de um `down` cria um
  // volume anônimo novo e o antigo fica órfão. O redis do CRM é efêmero (só limite de taxa e debounce,
  // `--save ""`, sem AOF): um tmpfs em /data ocupa o ponto de montagem sem guardar nada no disco.
  const bloco = (() => {
    const i = codigo.indexOf("\n  redis:\n");
    expect(i, "serviço redis").toBeGreaterThanOrEqual(0);
    const resto = codigo.slice(i + 1);
    const fim = resto.slice(1).search(/\n {2}[a-z][a-z0-9_-]*:\n/);
    return fim < 0 ? resto : resto.slice(0, fim + 1);
  })();

  it("monta /data como tmpfs (nada em volume)", () => {
    expect(bloco).toMatch(/\n {4}tmpfs:\n {6}- \/data\n/);
    expect(bloco).not.toMatch(/\n {4}volumes:/);
  });

  it("continua sem persistência", () => {
    expect(bloco).toContain('command: ["redis-server", "--save", "", "--appendonly", "no"]');
  });
});
