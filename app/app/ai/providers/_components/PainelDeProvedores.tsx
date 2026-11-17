"use client";

/**
 * O painel de provedores de IA.
 *
 * ## A decisão de desenho que manda em tudo aqui
 *
 * São 23 pontos configuráveis. Mostrar 23 seletores de uma vez transformaria a
 * tela num painel de avião para alguém que não é engenheiro — e o resultado
 * previsível seria ninguém tocar em nada, o que devolve o problema original.
 *
 * Então a tela abre agrupada por PAPEL ("Atender o cliente", "Entender a
 * conversa"…), mostrando o que cada grupo usa hoje. Quem quiser precisão
 * abre "Configuração avançada" e escolhe ponto a ponto. O agrupamento é só de
 * exibição: o que se grava é sempre por ponto, porque o roteiro do produto
 * prevê modelo local, e modelo local pequeno só é confiável como especialista
 * de uma tarefa só.
 *
 * ## Por que cada cartão mostra "o que acontece se falhar"
 *
 * A pergunta que trouxe esta tela à existência não foi "qual modelo está aqui",
 * foi "por que isso falhou e eu não vi". Um painel que só lista provedor e
 * modelo responde a primeira e deixa a segunda de pé. Por isso cada ponto
 * carrega o sintoma em português de gente — é o que liga uma linha de
 * configuração a algo que a pessoa já viu acontecer no negócio dela.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";

interface Ponto {
  id: string;
  rotulo: string;
  oQueFaz: string;
  papel: string;
  exige: { tools?: boolean; imagem?: boolean; audio?: boolean; embeddingDims?: number };
  sintomaDeFalha: string;
  fixo: { razao: string } | null;
  mandadoPeloAgente: boolean;
  efetivo: {
    provider: string;
    modelId: string | null;
    credentialId: string | null;
    baseUrl: string | null;
    origem: string;
    porQue: string;
    /** O provedor efetivo tem chave de verdade (credencial validada ou a dele no ambiente). */
    conectado: boolean;
  };
  avisos: string[];
}

interface Modelo {
  provider: string;
  model_id: string;
  display_name: string;
  supports_tools: boolean;
  supports_vision: boolean;
  input_price_per_million_cents: number | null;
}

interface ModeloDaChave {
  model_id: string;
  /** `null` = nem o provedor nem o catálogo sabem dizer. */
  supports_tools: boolean | null;
}

interface Credencial {
  id: string;
  provider: string;
  label: string;
  api_key_last4: string | null;
  /** Só o Ollama (modelo local, sem chave) tem endereço. */
  base_url?: string | null;
  /** Passou no teste real com o provedor. */
  conectada: boolean;
  /** De quando é a lista de modelos (último teste bem-sucedido). */
  validated_at: string | null;
  validation_error: string | null;
  /** A LISTA VIVA: modelos de conversa que esta chave libera. */
  modelos: ModeloDaChave[];
}

interface Conexao {
  provider: string;
  conectado: boolean;
  motivo: string | null;
  /** A instalação tem chave deste provedor (só o booleano, nunca o valor). */
  daInstalacao: boolean;
  listaAtualizadaEm: string | null;
}

/** A lista viva da chave da instalação, perguntada pelo servidor (a chave não vem). */
interface ListaDaInstalacao {
  conferida: boolean;
  motivo?: string;
  modelos: ModeloDaChave[];
  lidaEm: string | null;
}

/** Valor do seletor de chave para "usar a chave da instalação". */
const DA_INSTALACAO = "__instalacao__";

function quando(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

interface Provedor {
  id: string;
  rotulo: string;
  quandoUsar: string;
  ondePegarAChave: string;
  /** Aceita apontar para outro endpoint (é compatível com a API da OpenAI). */
  aceitaEndpointProprio: boolean;
}

interface Dados {
  papeis: Record<string, { rotulo: string; explicacao: string }>;
  pontos: Ponto[];
  provedores: Provedor[];
  credenciais: Credencial[];
  conexoes: Conexao[];
  gatewayDaInstalacao: boolean;
  listasDaInstalacao: Record<string, ListaDaInstalacao>;
  modelos: Modelo[];
  podeEditar: boolean;
}

export function PainelDeProvedores() {
  const t = useT();
  const [dados, setDados] = useState<Dados | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [avancado, setAvancado] = useState<Record<string, boolean>>({});

  const carregar = useCallback(async () => {
    // O try/catch não é zelo genérico: sem ele, qualquer exceção (rede caindo,
    // resposta que não é JSON, erro 500 com corpo HTML) deixava a tela presa em
    // "Carregando…" PARA SEMPRE, sem nada explicando. Medido na primeira
    // execução do e2e desta tela — que é a mesma falha muda que este painel
    // veio acabar, recriada dentro dele.
    try {
      const res = await fetch("/api/v1/ai/providers");
      const texto = await res.text();
      type Resposta = { data?: unknown; error?: { message?: string } };
      let json: Resposta | null = null;
      try {
        json = JSON.parse(texto) as Resposta;
      } catch {
        // Corpo não-JSON quer dizer que a resposta nem chegou ao handler
        // (proxy, erro de runtime). O começo do corpo é o que há de mais
        // informativo, então ele vai para a tela em vez de sumir no console.
        setErro(`${t("resposta inesperada do servidor")} (${res.status}): ${texto.slice(0, 200)}`);
        return;
      }
      if (!res.ok) {
        setErro(
          json?.error?.message
            ? t(json.error.message)
            : `${t("não consegui carregar a configuração")} (${res.status})`,
        );
        return;
      }
      setErro(null);
      setDados(json?.data as Dados);
    } catch (e) {
      setErro(e instanceof Error ? t(e.message) : t("não consegui falar com o servidor"));
    }
  }, [t]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const porPapel = useMemo(() => {
    if (!dados) return [];
    const grupos = new Map<string, Ponto[]>();
    for (const p of dados.pontos) {
      grupos.set(p.papel, [...(grupos.get(p.papel) ?? []), p]);
    }
    return [...grupos.entries()].map(([papel, pontos]) => ({
      papel,
      info: dados.papeis[papel] ?? { rotulo: papel, explicacao: "" },
      pontos,
    }));
  }, [dados]);

  if (erro) {
    return (
      <div className="p-6">
        <Card className="border-destructive/40 p-6">
          <h2 className="font-medium">{t("Não consegui carregar a configuração de IA")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{erro}</p>
          <Button className="mt-4" variant="outline" onClick={() => void carregar()}>
            {t("Tentar de novo")}
          </Button>
        </Card>
      </div>
    );
  }

  if (!dados) {
    return <div className="p-6 text-sm text-muted-foreground">{t("Carregando…")}</div>;
  }

  const semChave = dados.credenciais.length === 0;
  const algumaChaveDaInstalacao = dados.conexoes.some((c) => c.daInstalacao);

  return (
    <div className="mx-auto w-full max-w-5xl p-6" data-testid="painel-de-provedores">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Provedores de IA")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {t("Seu sistema usa inteligência artificial em")} {dados.pontos.length}{" "}
          {t("lugares diferentes. Aqui você vê qual está atendendo cada um — e troca, se quiser.")}
        </p>
      </header>

      {semChave && (
        <Card className="mb-6 border-amber-500/40 bg-amber-500/5 p-4" data-testid="aviso-sem-chave">
          <p className="text-sm">
            {algumaChaveDaInstalacao
              ? t(
                  "Você ainda não cadastrou nenhuma chave de provedor. Enquanto isso, tudo usa a chave que veio na instalação.",
                )
              : t(
                  "Nenhum provedor de IA está conectado. Cadastre e teste uma chave para escolher os modelos.",
                )}{" "}
            <Link className="underline underline-offset-4" href="/app/ai/credentials">
              {t("Cadastrar uma chave")}
            </Link>
          </p>
        </Card>
      )}

      <Conexoes dados={dados} />

      <div className="space-y-8">
        {porPapel.map(({ papel, info, pontos }) => (
          <section key={papel} data-testid={`papel-${papel}`}>
            <div className="mb-3">
              <h2 className="text-lg font-medium">{t(info.rotulo)}</h2>
              <p className="text-sm text-muted-foreground">{t(info.explicacao)}</p>
            </div>

            <ResumoDoGrupo pontos={pontos} />

            <div className="mt-3">
              <Button
                variant="ghost"
                size="sm"
                data-testid={`avancado-${papel}`}
                onClick={() => setAvancado((a) => ({ ...a, [papel]: !a[papel] }))}
              >
                {avancado[papel] ? t("Ocultar") : t("Configuração avançada")} ({pontos.length}{" "}
                {pontos.length === 1 ? t("ponto") : t("pontos")})
              </Button>
            </div>

            {avancado[papel] && (
              <div className="mt-3 space-y-3">
                {pontos.map((ponto) => (
                  <CartaoDoPonto
                    key={ponto.id}
                    ponto={ponto}
                    dados={dados}
                    aoSalvar={carregar}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * Cada provedor: conectado (chave própria testada) ou "conectar". É a
 * pergunta que vem antes de qualquer seletor: sem chave testada não há lista
 * de modelos para escolher.
 */
function Conexoes({ dados }: { dados: Dados }) {
  const t = useT();
  return (
    <Card className="mb-6 p-4" data-testid="conexoes-de-provedor">
      <h2 className="text-sm font-medium">{t("Provedores conectados")}</h2>
      <ul className="mt-2 space-y-2">
        {dados.provedores.map((p) => {
          const c = dados.conexoes.find((x) => x.provider === p.id);
          return (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
              data-testid={`conexao-${p.id}`}
            >
              <span className="flex flex-wrap items-center gap-2">
                {p.rotulo}
                {c?.conectado ? (
                  <Badge variant="secondary" className="text-xs">
                    {t("conectado")}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs">
                    {t("não conectado")}
                  </Badge>
                )}
                {c?.daInstalacao && (
                  <Badge variant="outline" className="text-xs">
                    {t("chave da instalação")}
                  </Badge>
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {c?.conectado ? (
                  <>
                    {t("Lista de modelos de")} {quando(c.listaAtualizadaEm)}
                  </>
                ) : (
                  <Link className="underline underline-offset-4" href="/app/ai/credentials">
                    {t("Conectar")}
                  </Link>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** O que o grupo usa hoje, sem obrigar a abrir ponto a ponto. */
function ResumoDoGrupo({ pontos }: { pontos: Ponto[] }) {
  const t = useT();
  // Só ponto CONECTADO entra no "usando": o id do modelo de um provedor sem
  // chave nenhuma é um modelo que não roda — mostrá-lo era o modelo fictício.
  const modelos = [
    ...new Set(
      pontos
        .filter((p) => p.efetivo.conectado)
        .map((p) => p.efetivo.modelId ?? t("não definido")),
    ),
  ];
  const desconectados = pontos.filter((p) => !p.efetivo.conectado).length;
  const comAviso = pontos.filter((p) => p.avisos.length > 0).length;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {modelos.length > 0 && <span className="text-muted-foreground">{t("Usando:")}</span>}
        {modelos.map((m) => (
          <Badge key={m} variant="secondary" className="font-mono text-xs">
            {m}
          </Badge>
        ))}
        {desconectados > 0 && (
          <span className="text-amber-600 dark:text-amber-500" data-testid="grupo-sem-provedor">
            {t("Nenhum provedor conectado")}
            {modelos.length > 0 ? ` (${desconectados})` : ""} ·{" "}
            <Link className="underline underline-offset-4" href="/app/ai/credentials">
              {t("Conectar em Credenciais")}
            </Link>
          </span>
        )}
      </div>
      {comAviso > 0 && (
        <p className="mt-2 text-sm text-amber-600 dark:text-amber-500" data-testid="grupo-com-aviso">
          {comAviso === 1
            ? t("1 ponto deste grupo precisa da sua atenção.")
            : `${comAviso} ${t("pontos deste grupo precisam da sua atenção.")}`}
        </p>
      )}
    </Card>
  );
}

function CartaoDoPonto({
  ponto,
  dados,
  aoSalvar,
}: {
  ponto: Ponto;
  dados: Dados;
  aoSalvar: () => Promise<void>;
}) {
  const t = useT();
  const [provider, setProvider] = useState(ponto.efetivo.provider);
  const [modelId, setModelId] = useState(ponto.efetivo.modelId ?? "");
  const [baseUrl, setBaseUrl] = useState(ponto.efetivo.baseUrl ?? "");
  const [salvando, setSalvando] = useState(false);
  const [atualizando, setAtualizando] = useState(false);

  const conexaoDe = (prov: string) => dados.conexoes.find((c) => c.provider === prov);
  // "Da instalação" só existe para o provedor cuja chave o SERVIDOR disse que
  // está no ambiente. O gateway de IA não conta: sem a chave do provedor, o
  // runtime roda o modelo padrão pelo gateway, não o escolhido aqui — era assim
  // que a Anthropic sem chave aparecia como "da instalação · Claude Sonnet 5".
  const temChaveDaInstalacao = (prov: string) => conexaoDe(prov)?.daInstalacao === true;
  const chaveInicial = (prov: string, atual: string | null): string => {
    if (atual) return atual;
    if (temChaveDaInstalacao(prov)) return DA_INSTALACAO;
    return dados.credenciais.find((c) => c.provider === prov && c.conectada)?.id ?? "";
  };
  const [credentialId, setCredentialId] = useState(() =>
    chaveInicial(ponto.efetivo.provider, ponto.efetivo.credentialId),
  );

  const credsDoProvider = dados.credenciais.filter((c) => c.provider === provider);
  const credsConectadas = credsDoProvider.filter((c) => c.conectada);
  const credEscolhida = credsDoProvider.find((c) => c.id === credentialId) ?? null;
  const usaInstalacao = credentialId === DA_INSTALACAO;
  const semChaveNenhuma = credsConectadas.length === 0 && !temChaveDaInstalacao(provider);
  // A LISTA VIVA, só conversa, e — no ponto que exige ferramentas — sem quem
  // comprovadamente não as tem. Chave própria: a lista dela. Chave da
  // instalação: a que o servidor perguntou ao provedor; se ele não conseguiu,
  // "não conferida" — o catálogo `ai_models` não entra no lugar dela.
  const listaDaInstalacao = usaInstalacao ? dados.listasDaInstalacao?.[provider] : undefined;
  const instalacaoConferida = listaDaInstalacao?.conferida === true;
  const listaViva = credEscolhida
    ? credEscolhida.modelos
    : instalacaoConferida
      ? listaDaInstalacao!.modelos
      : [];
  const listaDe = credEscolhida ? credEscolhida.validated_at : (listaDaInstalacao?.lidaEm ?? null);
  const modelosDaChave = listaViva.filter(
    (m) => !(ponto.exige.tools === true && m.supports_tools === false),
  );
  // O modelo JÁ GRAVADO aparece mesmo que a lista de hoje não o traga (lista
  // vazia porque o catálogo caiu, ou o provedor tirou o modelo): travar o
  // seletor aí impediria só desligar o ponto, e o servidor não confere a lista
  // quando o modelo não muda.
  const atualForaDaLista =
    modelId !== "" && !modelosDaChave.some((m) => m.model_id === modelId);
  const opcoesDaChave = atualForaDaLista
    ? [{ model_id: modelId, supports_tools: null }, ...modelosDaChave]
    : modelosDaChave;
  // Endpoint próprio só faz sentido em provedor compatível com a API da OpenAI
  // — é a mesma condição que `lib/ai/pontos/provedores.ts` declara e que o
  // registry aplica junto da allowlist do egress.
  const aceitaEndpointProprio =
    dados.provedores.find((p) => p.id === provider)?.aceitaEndpointProprio === true;

  const editavel = dados.podeEditar && ponto.fixo === null && !ponto.mandadoPeloAgente;

  async function salvar() {
    setSalvando(true);
    try {
      const res = await fetch("/api/v1/ai/providers", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purpose: ponto.id,
          provider,
          model_id: modelId,
          credential_id: usaInstalacao ? null : credentialId || null,
          // A coluna existia, o PUT a aceitava e o registry a honrava — e nada
          // na tela a enviava. Quem quisesse apontar para um gateway próprio (o
          // caso declarado como motivação da coluna, e o degrau para modelo
          // local) só conseguia pela API. Configuração sem superfície é
          // capacidade que ninguém alcança.
          base_url: aceitaEndpointProprio && baseUrl.trim() !== "" ? baseUrl.trim() : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        // A mensagem do servidor é escrita para leigo (ver validar-binding.ts).
        // `t()` repassa direto quando não há entrada no dicionário — não é
        // traduzir de novo, é a mesma degradação graciosa do resto do app.
        toast.error(json?.error?.message ? t(json.error.message) : t("não consegui salvar"));
        return;
      }
      const avisos: string[] = json?.data?.avisos ?? [];
      if (avisos.length > 0) avisos.forEach((a) => toast.warning(t(a)));
      else toast.success(`"${t(ponto.rotulo)}" ${t("agora usa")} ${modelId}`);
      await aoSalvar();
    } finally {
      setSalvando(false);
    }
  }

  async function atualizarModelos() {
    if (!credEscolhida) return;
    setAtualizando(true);
    try {
      // O revalidar pergunta de novo ao provedor e regrava a lista e a data.
      const res = await fetch(`/api/v1/ai/credentials/${credEscolhida.id}/revalidate`, {
        method: "POST",
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(
          json?.error?.message ? t(json.error.message) : t("não consegui atualizar os modelos"),
        );
        return;
      }
      if (json?.data?.validated_at) toast.success(t("Lista de modelos atualizada"));
      else if (credEscolhida.base_url) toast.error(t("O servidor Ollama não respondeu. Confira o endereço em Credenciais."));
      else toast.error(t("O provedor recusou a chave. Confira em Credenciais."));
      await aoSalvar();
    } finally {
      setAtualizando(false);
    }
  }

  const comEnderecoProprio = aceitaEndpointProprio && baseUrl.trim() !== "";

  return (
    <Card className="p-4" data-testid={`ponto-${ponto.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-medium">{t(ponto.rotulo)}</h3>
            {ponto.exige.tools && (
              <Badge variant="outline" className="text-xs">
                {t("precisa de ferramentas")}
              </Badge>
            )}
            {ponto.fixo && (
              <Badge variant="secondary" className="text-xs">
                {t("fixo")}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t(ponto.oQueFaz)}</p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          {ponto.efetivo.conectado ? (
            <div className="font-mono">{ponto.efetivo.modelId ?? "—"}</div>
          ) : (
            <div className="text-amber-600 dark:text-amber-500" data-testid={`sem-provedor-${ponto.id}`}>
              {t("Nenhum provedor conectado")}
            </div>
          )}
          <div data-testid={`origem-${ponto.id}`}>{t(ponto.efetivo.porQue)}</div>
        </div>
      </div>

      {/* O que a pessoa VÊ quando este ponto falha. É a razão de a tela existir. */}
      <p className="mt-3 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
        <span className="font-medium">{t("Se falhar:")}</span> {t(ponto.sintomaDeFalha)}
      </p>

      {ponto.avisos.map((a) => (
        <p
          key={a}
          className="mt-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-500"
          data-testid={`aviso-${ponto.id}`}
        >
          {t(a)}
        </p>
      ))}

      {ponto.fixo && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid={`razao-fixo-${ponto.id}`}>
          {t(ponto.fixo.razao)}
        </p>
      )}

      {ponto.mandadoPeloAgente && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("Este ponto usa o modelo definido na versão publicada do agente.")}{" "}
          <Link className="underline underline-offset-4" href="/app/ai/agents">
            {t("Configurar no agente")}
          </Link>
        </p>
      )}

      {editavel && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div>
            <Label className="text-xs">{t("Provedor")}</Label>
            <Select
              value={provider}
              onValueChange={(v) => {
                setProvider(v);
                setModelId("");
                setCredentialId(chaveInicial(v, null));
              }}
            >
              <SelectTrigger data-testid={`provider-${ponto.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dados.provedores.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.rotulo}
                    {conexaoDe(p.id)?.conectado || temChaveDaInstalacao(p.id)
                      ? ""
                      : ` — ${t("não conectado")}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">{provider === "ollama" ? t("Conexão") : t("Chave")}</Label>
            <Select
              value={credentialId}
              onValueChange={(v) => {
                setCredentialId(v);
                setModelId("");
              }}
              disabled={semChaveNenhuma}
            >
              <SelectTrigger data-testid={`chave-${ponto.id}`}>
                <SelectValue placeholder={provider === "ollama" ? t("escolha a conexão") : t("escolha a chave")} />
              </SelectTrigger>
              <SelectContent>
                {credsDoProvider.map((c) => (
                  <SelectItem key={c.id} value={c.id} disabled={!c.conectada}>
                    {c.label} {c.base_url ? `· ${c.base_url}` : `••${c.api_key_last4 ?? "??"}`}
                    {c.conectada ? "" : ` — ${t("não passou no teste")}`}
                  </SelectItem>
                ))}
                {temChaveDaInstalacao(provider) && (
                  <SelectItem value={DA_INSTALACAO}>{t("da instalação")}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">{t("Modelo")}</Label>
            {semChaveNenhuma ? (
              // Sem chave testada e sem chave da instalação não existe lista de
              // verdade — e lista inventada é o que esta tela deixou de mostrar.
              <>
                <Select disabled value="">
                  <SelectTrigger data-testid={`modelo-${ponto.id}`}>
                    <SelectValue placeholder={t("sem provedor conectado")} />
                  </SelectTrigger>
                  <SelectContent />
                </Select>
                <p className="mt-1 text-xs text-muted-foreground" data-testid={`motivo-${ponto.id}`}>
                  {t(conexaoDe(provider)?.motivo ?? "Provedor não conectado.")}{" "}
                  <Link className="underline underline-offset-4" href="/app/ai/credentials">
                    {t("Ir para Credenciais")}
                  </Link>
                </p>
              </>
            ) : comEnderecoProprio || (usaInstalacao && !instalacaoConferida) ? (
              /*
                Texto livre em dois casos só: endereço próprio (o gateway do
                operador serve modelos que nenhuma lista oficial conhece) e chave
                da instalação cuja lista o servidor NÃO conseguiu conferir com o
                provedor. Nesse segundo caso a tela diz isso, em vez de listar o
                catálogo como se fosse o que a chave libera.
              */
              <>
                <Input
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="ex.: meta-llama/llama-3.3-70b-instruct"
                  data-testid={`modelo-${ponto.id}`}
                />
                {usaInstalacao && !comEnderecoProprio && (
                  <p
                    className="mt-1 text-xs text-amber-600 dark:text-amber-500"
                    data-testid={`lista-nao-conferida-${ponto.id}`}
                  >
                    {t("Lista não conferida: o provedor não respondeu à chave da instalação.")}
                  </p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("Digite o identificador do modelo como o provedor o nomeia.")}
                </p>
              </>
            ) : !credEscolhida && !usaInstalacao ? (
              <Select disabled value="">
                <SelectTrigger data-testid={`modelo-${ponto.id}`}>
                  <SelectValue placeholder={t("escolha a chave primeiro")} />
                </SelectTrigger>
                <SelectContent />
              </Select>
            ) : (
              <>
                <Select
                  value={modelId}
                  onValueChange={setModelId}
                  disabled={opcoesDaChave.length === 0}
                >
                  <SelectTrigger data-testid={`modelo-${ponto.id}`}>
                    <SelectValue
                      placeholder={
                        opcoesDaChave.length === 0 ? t("a chave não liberou modelos") : t("escolha")
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {opcoesDaChave.map((m) => (
                      <SelectItem key={m.model_id} value={m.model_id}>
                        {m.model_id}
                        {atualForaDaLista && m.model_id === modelId
                          ? ` — ${t("atual, fora da lista de hoje")}`
                          : ponto.exige.tools && m.supports_tools === null
                            ? ` — ${t("ferramentas não verificadas")}`
                            : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span data-testid={`lista-de-${ponto.id}`}>
                    {t("Lista de")} {quando(listaDe)}
                  </span>
                  {credEscolhida && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    disabled={atualizando}
                    onClick={() => void atualizarModelos()}
                    data-testid={`atualizar-modelos-${ponto.id}`}
                  >
                    {atualizando ? t("Atualizando…") : t("Atualizar modelos")}
                  </Button>
                  )}
                </div>
              </>
            )}
          </div>

          {aceitaEndpointProprio && (
            <div className="sm:col-span-3">
              <Label className="text-xs">{t("Endereço próprio (opcional)")}</Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://mi-gateway.ejemplo.com/v1"
                data-testid={`base-url-${ponto.id}`}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t(
                  "Deixe em branco para usar o endereço oficial do provedor. Use isto para apontar para um gateway compatível com a API da OpenAI, num endereço https público — a sua chave é enviada para ele. Endereço local ou de rede interna não é aceito.",
                )}
              </p>
            </div>
          )}

          <div className="sm:col-span-3">
            <Button
              size="sm"
              disabled={salvando || !modelId}
              onClick={() => void salvar()}
              data-testid={`salvar-${ponto.id}`}
            >
              {salvando ? t("Salvando…") : t("Salvar")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
