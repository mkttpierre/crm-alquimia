"use client";

import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import {
  useAgentesExternos,
  useCriarAgente,
  useEditarAgente,
  useRevogarAgente,
  useSalvarMinutosDeEspera,
  type AgenteDaLista,
} from "@/hooks/team/useAgentesExternos";
import { blocoDeConexao, MARCADOR_DO_TOKEN } from "@/lib/agentes-externos/conexao";
import { GUIA_DO_AGENTE_EXTERNO } from "@/lib/agentes-externos/guia";
import {
  PAPEIS_DE_AGENTE_EXTERNO,
  TIPOS_DE_AGENTE_EXTERNO,
  type PapelDeAgenteExterno,
  type TipoDeAgenteExterno,
} from "@/lib/agentes-externos/modelo";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/** Rótulos em português; a tela passa cada um por `t()`. */
const ROTULO_DO_TIPO: Record<TipoDeAgenteExterno, string> = {
  openbot: "OpenBot",
  claude_code: "Claude Code",
  codex: "Codex",
  outro: "Outro",
};
const ROTULO_DO_PAPEL: Record<PapelDeAgenteExterno, string> = {
  admin: "Administrador",
  manager: "Gestor",
  agent: "Atendente",
};

const CLASSE_DO_SELECT =
  "h-10 w-full rounded-sm border border-border bg-bg px-3 text-sm text-text hover:border-border-strong focus-visible:outline-hidden focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-soft";

/** O card da tela: fundo `card`, borda de 1px, raio 12px (o mesmo da Início). */
function Cartao({ titulo, subtitulo, children, className }: { titulo?: string; subtitulo?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0 rounded-[12px] border border-border bg-card p-5 text-card-foreground", className)}>
      {titulo && <h2 className="text-[15px] leading-tight font-semibold">{titulo}</h2>}
      {subtitulo && <p className="mt-[3px] text-[13px] text-muted-foreground">{subtitulo}</p>}
      {children}
    </section>
  );
}

function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  return (partes.slice(0, 2).map((p) => [...p][0] ?? "").join("") || "?").toUpperCase();
}

export function AgentesClient() {
  const t = useT();
  const { data, isLoading } = useAgentesExternos();
  const [recemCriado, setRecemCriado] = useState<{ agente: AgenteDaLista; token: string } | null>(null);
  const appUrl = data?.app_url ?? "";
  const ativos = (data?.agentes ?? []).filter((a) => !a.revogado_em);
  const revogados = (data?.agentes ?? []).filter((a) => a.revogado_em);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 min-[861px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <NovoAgente onCriado={setRecemCriado} />
        <Cartao
          titulo={t("Como o agente se conecta")}
          subtitulo={t("O agente entra pelo servidor MCP do CRM, com um token só dele. Cole o bloco no app do agente.")}
        >
          <ul className="mt-4 flex flex-col gap-2 text-[13px] text-muted-foreground">
            <li>{t("1. Crie o agente aqui e copie o token: ele aparece uma vez só.")}</li>
            <li>{t("2. Escolha o atalho do app do agente e copie o bloco pronto.")}</li>
            <li>{t("3. Peça ao agente para ler o guia antes de trabalhar.")}</li>
          </ul>
          <div className="mt-4">
            <GuiaDoAgente />
          </div>
        </Cartao>
      </div>

      {data?.app_url_configurado === false && (
        <div role="status" className="rounded-[12px] border border-warning bg-warning-bg p-4 text-[13px] text-text">
          {t("O endereço público do CRM (NEXT_PUBLIC_APP_URL) não está configurado. O bloco de conexão usa o endereço desta página, que pode ser interno: confira a URL antes de colar no agente.")}
        </div>
      )}

      {recemCriado && (
        <Cartao
          titulo={`${t("Token de")} ${recemCriado.agente.nome}`}
          subtitulo={t("Copie agora: o token não será mostrado de novo.")}
          className="border-accent-500"
        >
          <BlocosDeConexao appUrl={appUrl} token={recemCriado.token} tipoInicial={recemCriado.agente.tipo} />
          <div className="mt-4 flex justify-end">
            <Button variant="outline" onClick={() => setRecemCriado(null)}>
              {t("Já copiei")}
            </Button>
          </div>
        </Cartao>
      )}

      <Cartao titulo={t("Agentes da equipe")} subtitulo={t("Online quando usou o CRM nos últimos 5 minutos.")}>
        {isLoading ? (
          <p className="mt-4 text-[13px] text-muted-foreground">{t("Carregando…")}</p>
        ) : ativos.length === 0 ? (
          <div className="mt-4 rounded-[10px] border border-dashed border-border p-4 text-[13px] text-muted-foreground">
            {t("Nenhum agente ainda. Crie o primeiro acima — por exemplo, o OpenBot que vai operar o CRM.")}
          </div>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {ativos.map((a) => (
              <LinhaDoAgente key={a.id} agente={a} appUrl={appUrl} />
            ))}
          </ul>
        )}
      </Cartao>

      <MinutosDeEspera atual={data?.minutos_conversa_esperando} />

      {revogados.length > 0 && (
        <Cartao titulo={t("Revogados")} subtitulo={t("Sem acesso. Ficam aqui porque o histórico mostra o que fizeram.")}>
          <ul className="mt-3 flex flex-col gap-1 text-[13px] text-muted-foreground">
            {revogados.map((a) => (
              <li key={a.id}>
                {a.nome} · {t(ROTULO_DO_TIPO[a.tipo])}
              </li>
            ))}
          </ul>
        </Cartao>
      )}
    </div>
  );
}

function NovoAgente({ onCriado }: { onCriado: (r: { agente: AgenteDaLista; token: string }) => void }) {
  const t = useT();
  const id = useId();
  const criar = useCriarAgente();
  const [nome, setNome] = useState("");
  const [tipo, setTipo] = useState<TipoDeAgenteExterno>("openbot");
  const [papel, setPapel] = useState<PapelDeAgenteExterno>("admin");
  const [podeMotor, setPodeMotor] = useState(true);

  return (
    <Cartao titulo={t("Novo agente")} subtitulo={t("Entra na equipe com nome, papel e acesso ao motor de disparo.")}>
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!nome.trim()) return;
          criar.mutate(
            { nome: nome.trim(), tipo, papel, pode_motor: podeMotor, avatar_url: null },
            {
              onSuccess: (r) => {
                onCriado({ agente: r.agente, token: r.token });
                setNome("");
              },
            },
          );
        }}
      >
        <label className="flex flex-col gap-1 text-[13px]" htmlFor={`${id}-nome`}>
          {t("Nome")}
          <Input id={`${id}-nome`} value={nome} maxLength={80} placeholder={t("Ex.: Head")} onChange={(e) => setNome(e.target.value)} />
        </label>
        <div className="grid gap-3 min-[521px]:grid-cols-2">
          <label className="flex flex-col gap-1 text-[13px]" htmlFor={`${id}-tipo`}>
            {t("App do agente")}
            <select id={`${id}-tipo`} className={CLASSE_DO_SELECT} value={tipo} onChange={(e) => setTipo(e.target.value as TipoDeAgenteExterno)}>
              {TIPOS_DE_AGENTE_EXTERNO.map((v) => (
                <option key={v} value={v}>
                  {t(ROTULO_DO_TIPO[v])}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[13px]" htmlFor={`${id}-papel`}>
            {t("Papel")}
            <select id={`${id}-papel`} className={CLASSE_DO_SELECT} value={papel} onChange={(e) => setPapel(e.target.value as PapelDeAgenteExterno)}>
              {[...PAPEIS_DE_AGENTE_EXTERNO].reverse().map((v) => (
                <option key={v} value={v}>
                  {t(ROTULO_DO_PAPEL[v])}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex items-center justify-between gap-3 text-[13px]" htmlFor={`${id}-motor`}>
          <span>{t("Pode operar o motor de disparo")}</span>
          <Switch id={`${id}-motor`} checked={podeMotor} onCheckedChange={setPodeMotor} />
        </label>
        <p className="text-[12px] text-muted-foreground">
          {t("O agente nunca fecha venda: sem preço, sem link de pagamento e sem registrar venda. Ele cria uma tarefa para alguém da equipe.")}
        </p>
        <div className="flex justify-end">
          <Button type="submit" disabled={criar.isPending || !nome.trim()}>
            {criar.isPending ? t("Criando…") : t("Criar agente")}
          </Button>
        </div>
      </form>
    </Cartao>
  );
}

function BlocosDeConexao({ appUrl, token, tipoInicial }: { appUrl: string; token: string; tipoInicial: TipoDeAgenteExterno }) {
  const t = useT();
  const [tipo, setTipo] = useState<TipoDeAgenteExterno>(tipoInicial);
  const bloco = blocoDeConexao(tipo, appUrl, token);
  return (
    <div className="mt-4 flex flex-col gap-3">
      <div role="tablist" aria-label={t("Atalho")} className="flex flex-wrap gap-1.5">
        {TIPOS_DE_AGENTE_EXTERNO.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={tipo === v}
            onClick={() => setTipo(v)}
            className={cn(
              "rounded-full border px-3 py-1 text-[12px]",
              tipo === v ? "border-accent-500 bg-accent-soft text-text" : "border-border text-muted-foreground hover:border-border-strong",
            )}
          >
            {t(ROTULO_DO_TIPO[v])}
          </button>
        ))}
      </div>
      <pre className="max-h-64 overflow-auto rounded-[10px] border border-border bg-bg p-3 text-[12px] leading-relaxed whitespace-pre-wrap break-all">
        {bloco}
      </pre>
      {tipo === "codex" && (
        <p className="text-[12px] text-muted-foreground">
          {t("No Codex o token fica numa variável de ambiente, não no arquivo: defina a variável antes de abrir o Codex.")}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          type="button"
          onClick={async () => {
            const copiou = await copyToClipboard(bloco);
            if (copiou) toast.success(t("Bloco copiado."));
            else toast.error(t("Não foi possível copiar. Selecione o texto e copie à mão."));
          }}
        >
          {t("Copiar")}
        </Button>
      </div>
    </div>
  );
}

function presenca(agente: AgenteDaLista, t: (s: string) => string): string {
  if (!agente.ultimo_uso_em) return t("Ainda não se conectou");
  const minutos = Math.max(0, Math.floor((Date.now() - Date.parse(agente.ultimo_uso_em)) / 60_000));
  const quando = minutos < 1 ? t("agora") : minutos < 60 ? `${t("há")} ${minutos} min` : `${t("há")} ${Math.floor(minutos / 60)} h`;
  return agente.ultima_acao ? `${agente.ultima_acao} · ${quando}` : quando;
}

function LinhaDoAgente({ agente, appUrl }: { agente: AgenteDaLista; appUrl: string }) {
  const t = useT();
  const id = useId();
  const editar = useEditarAgente();
  const revogar = useRevogarAgente();

  return (
    <li className="flex flex-col gap-3 rounded-[10px] border border-border p-3 min-[861px]:flex-row min-[861px]:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span aria-hidden className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-[12px] font-semibold">
          {iniciais(agente.nome)}
          <i
            className={cn(
              "absolute -right-px -bottom-px h-[10px] w-[10px] rounded-full border-2 border-card",
              agente.online ? "bg-presenca-online" : "bg-presenca-ausente",
            )}
          />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[14px] font-medium">
            {agente.nome} <span className="text-[12px] font-normal text-muted-foreground">· {t(ROTULO_DO_TIPO[agente.tipo])}</span>
          </p>
          <p className="truncate text-[12px] text-muted-foreground">
            <span className="sr-only">{agente.online ? t("online") : t("ausente")} · </span>
            {presenca(agente, t)}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label={t("Papel")}
          className={cn(CLASSE_DO_SELECT, "h-9 w-auto")}
          value={agente.papel}
          disabled={editar.isPending}
          onChange={(e) => editar.mutate({ id: agente.id, edicao: { papel: e.target.value as PapelDeAgenteExterno } })}
        >
          {[...PAPEIS_DE_AGENTE_EXTERNO].reverse().map((v) => (
            <option key={v} value={v}>
              {t(ROTULO_DO_PAPEL[v])}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-[12px]" htmlFor={`${id}-motor`}>
          {t("Motor")}
          <Switch
            id={`${id}-motor`}
            checked={agente.pode_motor}
            disabled={editar.isPending}
            onCheckedChange={(v) => editar.mutate({ id: agente.id, edicao: { pode_motor: v } })}
          />
        </label>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              {t("Bloco de conexão")}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-[640px]">
            <DialogHeader>
              <DialogTitle>{`${t("Conectar")} ${agente.nome}`}</DialogTitle>
            </DialogHeader>
            <p className="text-[13px] text-muted-foreground">
              {t("O token só aparece na criação. Troque o marcador pelo token que você guardou; se perdeu, revogue e crie de novo.")}
            </p>
            <BlocosDeConexao appUrl={appUrl} token={MARCADOR_DO_TOKEN} tipoInicial={agente.tipo} />
          </DialogContent>
        </Dialog>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" disabled={revogar.isPending}>
              {t("Revogar")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{`${t("Revogar")} ${agente.nome}?`}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("O token deixa de funcionar na hora e o agente perde o acesso ao CRM. O histórico do que ele fez continua.")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
              <AlertDialogAction onClick={() => revogar.mutate(agente.id)}>{t("Revogar")}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </li>
  );
}

function MinutosDeEspera({ atual }: { atual: number | undefined }) {
  const t = useT();
  const id = useId();
  const salvar = useSalvarMinutosDeEspera();
  const [valor, setValor] = useState<string | null>(null);
  const mostrado = valor ?? (atual !== undefined ? String(atual) : "");
  const numero = Number(mostrado);
  const valido = Number.isInteger(numero) && numero >= 1 && numero <= 1440;

  return (
    <Cartao
      titulo={t("Aviso de conversa esperando")}
      subtitulo={t("Os agentes podem assinar o aviso em Webhooks › Automações. Ele sai uma vez por conversa, quando o cliente fica sem resposta por este tempo.")}
    >
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valido) salvar.mutate(numero, { onSuccess: () => setValor(null) });
        }}
      >
        <label className="flex flex-col gap-1 text-[13px]" htmlFor={`${id}-min`}>
          {t("Minutos sem resposta")}
          <Input
            id={`${id}-min`}
            type="number"
            min={1}
            max={1440}
            className="w-32"
            value={mostrado}
            aria-invalid={!valido}
            onChange={(e) => setValor(e.target.value)}
          />
        </label>
        <Button type="submit" variant="outline" disabled={!valido || salvar.isPending || valor === null}>
          {t("Salvar")}
        </Button>
      </form>
    </Cartao>
  );
}

function GuiaDoAgente() {
  const t = useT();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">{t("Ver o guia do agente")}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle>{t("Guia do agente")}</DialogTitle>
        </DialogHeader>
        <p className="text-[13px] text-muted-foreground">
          {t("O mesmo texto está no MCP como o recurso crm://guia/agentes-externos. Copie e cole no agente, se ele não ler recursos.")}
        </p>
        <pre className="max-h-[60vh] overflow-auto rounded-[10px] border border-border bg-bg p-3 text-[12px] leading-relaxed whitespace-pre-wrap">
          {GUIA_DO_AGENTE_EXTERNO}
        </pre>
        <div className="flex justify-end">
          <Button
            onClick={async () => {
              const copiou = await copyToClipboard(GUIA_DO_AGENTE_EXTERNO);
              if (copiou) toast.success(t("Guia copiado."));
              else toast.error(t("Não foi possível copiar. Selecione o texto e copie à mão."));
            }}
          >
            {t("Copiar")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
