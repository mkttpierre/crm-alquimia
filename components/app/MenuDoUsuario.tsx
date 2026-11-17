"use client";

import Link from "next/link";
import { useTransition, type ReactNode } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { ROTULO_DO_PAPEL } from "@/lib/auth/types";
import { useTheme, type Theme } from "@/lib/theme";
import { SignOut, UserCircle } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/** "Ana Prado" → "AP"; sem nome, as duas primeiras letras do e-mail. */
export function iniciaisDoUsuario(nome: string | null, email: string): string {
  const partes = (nome ?? "").trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return email.slice(0, 2).toUpperCase();
  return partes
    .slice(0, 2)
    .map((p) => [...p][0] ?? "")
    .join("")
    .toUpperCase();
}

/** O primeiro nome, para o "Olá, …" do topo; sem nome, a parte local do e-mail. */
export function primeiroNome(nome: string | null, email: string): string {
  return (nome ?? "").trim().split(/\s+/)[0] || email.split("@")[0] || email;
}

/** A bolinha com as iniciais (ou a foto) de quem está logado. */
export function AvatarDoUsuario({
  tamanho = 32,
  className,
}: {
  tamanho?: number;
  className?: string;
}) {
  const { user } = useAuth();
  return (
    <span
      aria-hidden
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-lateral-avatar text-[12px] font-semibold text-lateral",
        className,
      )}
      style={{ width: tamanho, height: tamanho }}
    >
      {user.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={user.avatar_url} alt="" className="h-full w-full object-cover" />
      ) : (
        iniciaisDoUsuario(user.full_name, user.email)
      )}
    </span>
  );
}

/**
 * O menu de quem está logado: perfil, tema e sair. Abre do rodapé da barra
 * lateral e do avatar do topo — o mesmo conteúdo, para não haver duas listas.
 * O atalho de tema (⌘⇧L) mora no `Topo`, que existe uma vez só: registrado
 * aqui, ele dispararia uma vez por menu montado e o tema andaria duas casas.
 */
export function MenuDoUsuario({
  children,
  lado = "bottom",
  alinhamento = "end",
}: {
  /** O gatilho (botão). */
  children: ReactNode;
  lado?: "top" | "bottom";
  alinhamento?: "start" | "end";
}) {
  const t = useT();
  const { user, activeOrg, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const [saindo, startTransition] = useTransition();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side={lado} align={alinhamento} className="min-w-[230px]">
        <DropdownMenuLabel>
          <div className="flex flex-col">
            <span className="text-sm font-medium">{user.full_name ?? user.email}</span>
            <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            {activeOrg?.role && (
              <span className="text-xs text-muted-foreground">
                {t(ROTULO_DO_PAPEL[activeOrg.role])}
              </span>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/app/settings/profile" prefetch={false}>
            <UserCircle size={16} className="mr-2" aria-hidden />
            {t("Perfil")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("Tema")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
          <DropdownMenuRadioItem value="dark">{t("Escuro")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">{t("Claro")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">{t("Do sistema")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={saindo}
          onClick={() =>
            startTransition(async () => {
              await signOut();
            })
          }
        >
          <SignOut size={16} className="mr-2" aria-hidden />
          {t("Sair")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
