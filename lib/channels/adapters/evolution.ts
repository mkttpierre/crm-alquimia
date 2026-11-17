/**
 * Adapter Evolution API v2 — o quarto `ChannelAdapter`.
 *
 * Burro como os irmãos: traduz formato e nada mais. Janela, cap diário, horário
 * comercial, retry e throttle são da cadeia `before_send`; quem quiser saber o
 * que o canal permite pergunta a `capabilitiesOf` (doutrina `restricao-de-canal.md`).
 *
 * O transporte é o WhatsApp Web (Baileys) por trás da Evolution, então o
 * endereçamento e a identidade espelham o canal WAHA: telefone em dígitos ou
 * `<lid>@lid`, e o id da mensagem é o id cru do Baileys dos dois lados (o envio
 * devolve `key.id`, o webhook repete `key.id`) — por isso este adapter NÃO
 * precisa de `echoExternalIds`: o eco casa direto por `external_id`.
 *
 * ─── A credencial vive na SESSÃO, e `isConfigured` não pode olhar o banco ──────
 * Mesma decisão do adapter do canal intermediado: o método é síncrono, então
 * responde `true` e quem desiste é `send()`, que pode consultar o banco — e que
 * LANÇA `evolution_not_configured`. Devolver `{ externalId: null }` faria o
 * handler gravar `sent` para algo que nunca saiu.
 */
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import type { FetchedMedia } from "@/lib/messaging/media/types";

import { DETALHE_CREDENCIAL_RECUSADA } from "../health";
import {
  baixarMidia,
  enviarAudio,
  enviarMidia,
  enviarPresenca,
  enviarTexto,
  estadoDaInstancia,
  fotoDePerfil,
  idDaRespostaDeEnvio,
  statusHttpDoErroEvolution,
} from "../evolution/client";
import { resolveEvolutionCreds } from "../evolution/credentials";
import { idDaReferenciaDeMidia, statusDoEstado } from "../evolution/webhook";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
  SendResult,
} from "../types";

/** Só dígitos. `+55 (81) 9 9999-0000` → `5581999990000`. */
function soDigitos(raw: string): string {
  return raw.replace(/\D/g, "");
}

export const evolutionAdapter: ChannelAdapter = {
  provider: "evolution",

  /**
   * O `number` da API: dígitos do telefone, ou `<lid>@lid` quando o contato só
   * é conhecido por Linked ID.
   *
   * O `lid` vem ANTES do telefone, pela mesma razão do canal WAHA (migration
   * 0122): o telefone entra para o CRM identificar e deduplicar, mas o ENVIO
   * continua indo por onde a conversa veio — contato em modo privacidade
   * frequentemente não é endereçável pelo número.
   *
   * Grupo devolve `null`: a ingestão descarta grupo e a capability declara
   * `groups: "none"`. Fingir que o chatId cabe aqui mandaria a mensagem para um
   * lugar que ninguém testou.
   */
  resolveRecipient(input: RecipientInput): string | null {
    if (input.isGroup) return null;
    if (input.waLid) return `${input.waLid}@lid`;
    if (input.waIdentity?.startsWith("lid:")) return `${input.waIdentity.slice(4)}@lid`;
    const doIdentity = input.waIdentity?.startsWith("phone:")
      ? input.waIdentity.slice("phone:".length)
      : null;
    const bruto = doIdentity ?? input.phoneNumber ?? null;
    if (!bruto) return null;
    const digitos = soDigitos(bruto);
    return digitos.length > 0 ? digitos : null;
  },

  // Sempre `true`: ver o cabeçalho. `send()` é quem desiste, e LANÇA.
  isConfigured(): boolean {
    return true;
  },

  codes: {
    notConfigured: "evolution_not_configured",
    sendFailed: "evolution_error",
    unknownError: "evolution_unknown",
  },

  async send(envelope: OutboundEnvelope): Promise<SendResult> {
    if (envelope.kind === "contact") {
      throw new Error(
        "evolution_contact_not_supported: envio de cartão de contato não suportado neste canal.",
      );
    }
    const admin = createAdminClient();
    const creds = await resolveEvolutionCreds(admin, {
      organizationId: envelope.organizationId,
      instance: envelope.sessionRef,
    });
    if (!creds) {
      throw new Error(
        "evolution_not_configured: nenhuma credencial para esta instância (nem na sessão, nem no ambiente).",
      );
    }

    await envelope.beforeSend?.();

    // "digitando/gravando" antes da mensagem: enfeite. Se falhar, a mensagem sai do mesmo jeito.
    if (envelope.presence && envelope.presence.ms > 0) {
      try {
        await enviarPresenca(creds, { number: envelope.to, presence: envelope.presence.kind, delayMs: envelope.presence.ms });
      } catch (e) {
        logger.warn("[evolution] presença não enviada", {
          organizationId: envelope.organizationId,
          sessionRef: envelope.sessionRef,
          motivo: (e as Error).message.slice(0, 120),
        });
      }
    }

    let res: unknown;
    if (envelope.media) {
      if (envelope.kind === "audio") {
        // Bolha de voz: a Evolution converte para ogg/opus (`encoding: true`).
        res = await enviarAudio(creds, { number: envelope.to, url: envelope.media.url });
      } else {
        res = await enviarMidia(creds, {
          number: envelope.to,
          kind: envelope.kind,
          url: envelope.media.url,
          mime: envelope.media.mime,
          filename: envelope.media.filename,
          caption: envelope.media.caption,
        });
      }
    } else {
      res = await enviarTexto(creds, {
        number: envelope.to,
        text: envelope.body ?? "",
        // A citação é enfeite, nunca condição de envio (ver `OutboundEnvelope`).
        replyToExternalId: envelope.replyToExternalId,
      });
    }

    const externalId = idDaRespostaDeEnvio(res);
    if (!externalId) {
      // HTTP 2xx sem `key.id`: o transporte aceitou, mas não há como provar a
      // saída nem casar o eco do webhook. NÃO lança (viraria `failed` e o
      // follow-up reenviaria, possivelmente em dobro) e NÃO reenvia aqui: só
      // sinaliza. Rastro sem corpo da mensagem nem destinatário.
      logger.warn("[evolution] envio aceito sem key.id", {
        organizationId: envelope.organizationId,
        sessionRef: envelope.sessionRef,
        kind: envelope.kind,
        motivo: "resposta_sem_key_id",
      });
      return { externalId: null, confirmado: false, motivo: "resposta_sem_key_id" };
    }
    return { externalId };
  },

  async fetchProfilePictureUrl(
    input: ChannelTenantScope & { sessionRef: string; recipient: string },
  ): Promise<string | null> {
    const admin = createAdminClient();
    const creds = await resolveEvolutionCreds(admin, {
      organizationId: input.organizationId,
      instance: input.sessionRef,
    });
    if (!creds) return null;
    try {
      return await fotoDePerfil(creds, input.recipient);
    } catch {
      // Foto é enfeite: privacidade fechada e servidor fora do ar têm o mesmo
      // desfecho aqui — sem foto.
      return null;
    }
  },

  /**
   * Baixa o anexo que o cliente mandou.
   *
   * A URL do payload é uma REFERÊNCIA nossa (`evolution-media:<id>`, montada em
   * `traduzirMensagem`), não um endereço: a Evolution não expõe link público do
   * anexo. O download é uma chamada autenticada ao PRÓPRIO servidor Evolution
   * da sessão — nenhum host sai do payload, então não há SSRF a guardar.
   */
  async fetchInboundMedia(
    input: ChannelTenantScope & { sessionRef: string; url: string; hintMime?: string | null },
  ): Promise<FetchedMedia> {
    const id = idDaReferenciaDeMidia(input.url);
    if (!id) throw new Error("evolution_media_failed: referência de mídia desconhecida.");

    const admin = createAdminClient();
    const creds = await resolveEvolutionCreds(admin, {
      organizationId: input.organizationId,
      instance: input.sessionRef,
    });
    if (!creds) throw new Error("evolution_not_configured: sem credencial para baixar a mídia.");

    const midia = await baixarMidia(creds, id);
    if (!midia) throw new Error("evolution_media_failed: a Evolution não devolveu o arquivo.");

    // `data:<mime>;base64,` pode vir como prefixo, conforme a versão da API.
    const base64 = midia.base64.replace(/^data:[^;]*;base64,/, "");
    return {
      buffer: Buffer.from(base64, "base64"),
      mime: midia.mimetype || input.hintMime || "application/octet-stream",
    };
  },

  /**
   * Pergunta à Evolution se a instância está de pé — mesmos três desfechos do
   * canal WAHA, pelo mesmo motivo (ver `wahaAdapter.checkHealth`):
   *
   *   - respondeu com estado → é a verdade do momento (`open` → WORKING,
   *     `connecting` → STARTING, `close` → STOPPED);
   *   - 404 → a instância não existe mais no servidor: STOPPED. É a resposta,
   *     não erro de rede;
   *   - 401/403 → a apikey foi recusada: acesso ao transporte inteiro, não o
   *     estado do número. `reachable: false` com o detalhe que a Central lê;
   *   - qualquer outro erro → NÃO sabemos. Inventar um estado trocaria uma
   *     oscilação de rede por "canal caído".
   */
  async checkHealth(input: ChannelTenantScope & { sessionRef: string }): Promise<ChannelHealth> {
    const admin = createAdminClient();
    let creds;
    try {
      creds = await resolveEvolutionCreds(admin, {
        organizationId: input.organizationId,
        instance: input.sessionRef,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "erro_desconhecido";
      return { reachable: false, status: null, detail: msg.slice(0, 200) };
    }
    if (!creds) return { reachable: false, status: null, detail: "transporte_nao_configurado" };

    try {
      const estado = await estadoDaInstancia(creds);
      const status = statusDoEstado(estado);
      if (!status) {
        return { reachable: false, status: null, detail: `estado_desconhecido:${estado ?? "vazio"}`.slice(0, 200) };
      }
      return { reachable: true, status, detail: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "erro_desconhecido";
      const http = statusHttpDoErroEvolution(msg);
      if (http === 404) return { reachable: true, status: "STOPPED", detail: null };
      if (http === 401 || http === 403) {
        return { reachable: false, status: null, detail: DETALHE_CREDENCIAL_RECUSADA };
      }
      return { reachable: false, status: null, detail: msg.slice(0, 200) };
    }
  },
};
