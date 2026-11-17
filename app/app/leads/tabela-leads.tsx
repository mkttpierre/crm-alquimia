"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { BotaoExportarCsv } from "@/components/exportacao/BotaoExportarCsv";
import { BotaoRegistrarVenda } from "@/components/negocio/BotaoRegistrarVenda";
import type { LinhaLead, OrdemLead } from "@/lib/negocio/selecionar-leads";

type Visao = { nome: string; consulta: string };
/** Marca da primeira página na pilha `anteriores` (ela não tem cursor; cursor nunca é "_"). */
const PRIMEIRA_PAGINA = "_";
/** Visão padrão pagina pelo cursor (50 por vez); ordens calculadas, por número de página. */
export type Paginacao =
  | { tipo: "cursor"; atual: string; anteriores: string[]; proximo: string | null }
  | { tipo: "pagina"; pagina: number; porPagina: number };
export function TabelaLeads({ org, resultado, paginacao, pipelines, tags, podeExportar = false }: { org: string; resultado: { linhas: LinhaLead[]; total: number }; paginacao: Paginacao; pipelines: { id: string; name: string }[]; tags: string[]; podeExportar?: boolean }) {
  const t = useT(); const idioma = useTagDeIdioma(); const router = useRouter(); const path = usePathname(); const params = useSearchParams();
  const [visoes, setVisoes] = useState<Visao[]>([]); const [nome, setNome] = useState("");
  const chave = `leads-visoes:${org}`;
  useEffect(() => { const timer = setTimeout(() => { try { const valor: unknown = JSON.parse(localStorage.getItem(chave) ?? "[]"); if (Array.isArray(valor)) setVisoes(valor.filter((v): v is Visao => !!v && typeof v.nome === "string" && typeof v.consulta === "string")); } catch {} }, 0); return () => clearTimeout(timer); }, [chave]);
  // A visão guarda filtros e ordem, não a posição na paginação: um cursor salvo envelhece.
  function salvar() { if (!nome.trim()) return; const consulta = new URLSearchParams(params.toString()); consulta.delete("cursor"); consulta.delete("anteriores"); consulta.delete("pagina"); const novas = [...visoes, { nome: nome.trim(), consulta: consulta.toString() }]; try { localStorage.setItem(chave, JSON.stringify(novas)); setVisoes(novas); setNome(""); } catch { /* armazenamento indisponível */ } }
  function navegar(mudancas: Record<string, string>) { const p = new URLSearchParams(params.toString()); for (const [k,v] of Object.entries(mudancas)) { if (v) p.set(k,v); else p.delete(k); } router.push(`${path}?${p}`); }
  const colunas: [OrdemLead, string][] = [["tipo","Tipo"],["nome","Contato"],["tags","Tags"],["total","Total gasto"],["compras","Compras"],["ciclo","Ciclo de compra"],["ultima","Última compra"]];
  // Cursor: "Anterior" desempilha o cursor de onde se veio (a pilha viaja na URL, `anteriores`).
  const temAnterior = paginacao.tipo === "cursor" ? paginacao.anteriores.length > 0 : paginacao.pagina > 1;
  const temProxima = paginacao.tipo === "cursor" ? paginacao.proximo !== null : paginacao.pagina * paginacao.porPagina < resultado.total;
  function proxima() { if (paginacao.tipo === "pagina") return navegar({ pagina:String(paginacao.pagina + 1) }); if (paginacao.proximo) navegar({ cursor:paginacao.proximo, anteriores:[...paginacao.anteriores, paginacao.atual || PRIMEIRA_PAGINA].join(",") }); }
  function anterior() { if (paginacao.tipo === "pagina") return navegar({ pagina:String(paginacao.pagina - 1) }); const pilha = [...paginacao.anteriores]; const volta = pilha.pop(); navegar({ cursor:volta && volta !== PRIMEIRA_PAGINA ? volta : "", anteriores:pilha.join(",") }); }
  const campo = "h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground";
  return <main className="space-y-5 p-6">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">{t("Leads")}</h1><p className="text-sm text-muted-foreground">{resultado.total} {t("contatos")}</p></div>{podeExportar && <BotaoExportarCsv rota="leads" filtros={{ busca: params.get("busca"), tag: params.get("tag"), pipeline: params.get("pipeline"), de: params.get("de"), ate: params.get("ate") }} />}</header>
    <div className="flex flex-wrap items-center gap-2" aria-label={t("Visões salvas")}>
      <button className={campo} onClick={() => router.push(path)}>{t("Todos")}</button>
      {visoes.map((v,i) => <span className="inline-flex" key={`${v.nome}-${i}`}><button className={campo} onClick={() => router.push(`${path}?${v.consulta}`)}>{v.nome}</button><button className={campo} aria-label={`${t("Excluir visão")} ${v.nome}`} onClick={() => { const novas = visoes.filter((_,j) => i !== j); try { localStorage.setItem(chave,JSON.stringify(novas)); setVisoes(novas); } catch { /* armazenamento indisponível */ } }}>×</button></span>)}
      <input className={campo} value={nome} onChange={(e) => setNome(e.target.value)} placeholder={t("Nome da visão")} aria-label={t("Nome da visão")} /><button className={campo} onClick={salvar}>{t("Salvar visão")}</button>
    </div>
    <form action={path} className="flex flex-wrap gap-2 rounded-lg border border-border bg-surface p-3">
      <input className={campo} name="busca" defaultValue={params.get("busca") ?? ""} placeholder={t("Buscar por nome, telefone ou tag")} aria-label={t("Buscar por nome, telefone ou tag")} />
      <input className={campo} name="tag" list="leads-tags" defaultValue={params.get("tag") ?? ""} placeholder={t("Tag: todas")} aria-label={t("Tag")} /><datalist id="leads-tags">{tags.map((v) => <option key={v} value={v} />)}</datalist>
      <select className={campo} name="pipeline" defaultValue={params.get("pipeline") ?? ""} aria-label={t("Funil")}><option value="">{t("Todos os funis")}</option>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <label className="text-sm">{t("Última compra desde")} <input className={campo} type="date" name="de" defaultValue={params.get("de") ?? ""} /></label>
      <label className="text-sm">{t("até")} <input className={campo} type="date" name="ate" defaultValue={params.get("ate") ?? ""} /></label>
      <button className={`${campo} bg-primary text-primary-foreground`} type="submit">{t("Filtrar")}</button>
    </form>
    <div className="relative max-w-full overflow-x-auto rounded-lg border border-border bg-surface"><table className="w-full text-left text-sm"><thead className="border-b border-border text-muted-foreground"><tr>{colunas.map(([id,label]) => <th key={id} className="whitespace-nowrap p-3"><button onClick={() => navegar({ ordem:id, direcao:params.get("ordem") === id && params.get("direcao") !== "desc" ? "desc" : "asc", pagina:"", cursor:"", anteriores:"" })}>{t(label)} {params.get("ordem") === id ? (params.get("direcao") === "desc" ? "↓" : "↑") : ""}</button></th>)}<th className="p-3"><span className="sr-only">{t("Ações")}</span></th></tr></thead><tbody>{resultado.linhas.map((l) => <tr key={l.id} className="border-b border-border last:border-0"><td className="p-3"><span className="rounded-full bg-muted px-2 py-1">{t(l.tipo === "empresa" ? "Empresa" : "Pessoa")}</span></td><td className="p-3"><Link className="font-medium hover:underline" href={`/app/contacts/${l.id}`}>{l.nome || t("Contato sem nome")}</Link><div className="text-muted-foreground">{l.telefone}</div></td><td className="p-3"><div className="flex flex-wrap gap-1">{l.tags.map((tag) => <span className="rounded-md bg-muted px-2 py-1" key={tag}>{tag}</span>)}</div></td><td className="whitespace-nowrap p-3">{new Intl.NumberFormat(idioma, { style:"currency", currency:"BRL" }).format(l.total / 100)}</td><td className="p-3">{l.compras}</td><td className="whitespace-nowrap p-3">{l.ciclo === null ? "—" : `${l.ciclo} ${t("dias")}`}</td><td className="whitespace-nowrap p-3">{l.ultima ? new Intl.DateTimeFormat(idioma, { timeZone:"UTC" }).format(new Date(l.ultima)) : "—"}</td><td className="whitespace-nowrap p-3 text-right"><BotaoRegistrarVenda contactId={l.id} nomeDoContato={l.nome || null} /></td></tr>)}</tbody></table>{resultado.linhas.length === 0 && <p className="p-6 text-center text-muted-foreground">{t("Nenhum contato encontrado.")}</p>}</div>
    <div className="flex items-center justify-between text-sm"><span>{resultado.total} {t("contatos")}</span><div className="flex gap-2"><button className={campo} disabled={!temAnterior} onClick={anterior}>{t("Anterior")}</button><button className={campo} disabled={!temProxima} onClick={proxima}>{t("Próxima")}</button></div></div>
  </main>;
}
