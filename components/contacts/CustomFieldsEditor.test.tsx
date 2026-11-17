import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CustomFieldsEditor, type CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";

const campos: CustomFieldDef[] = [
  { key: "trilha", label: "Trilha", type: "text" },
  { key: "quente", label: "Lead quente", type: "boolean" },
  { key: "obs", label: "Observação", type: "textarea" },
] as CustomFieldDef[];

describe("campos extras no painel estreito da conversa (15/11/2026)", () => {
  // Bug: no painel do contato a grade tem 1 coluna, mas os campos de sim/não e de texto longo pediam
  // `col-span-2`; o navegador criava uma 2ª coluna fantasma e espremia Trilha, Classe e Kit escolhido.
  // `col-span-full` ocupa a linha inteira com 1 ou 2 colunas.
  it("nenhum campo pede 2 colunas fixas; os largos ocupam a linha inteira", () => {
    const { container } = render(
      <CustomFieldsEditor fields={campos} value={{}} onChange={() => {}} mode="lead" className="md:grid-cols-1" />,
    );
    const grade = container.firstElementChild!;
    const filhos = [...grade.children];
    expect(filhos.some((c) => /col-span-2/.test(c.className))).toBe(false);
    expect(filhos.filter((c) => /md:col-span-full/.test(c.className))).toHaveLength(2);
  });
});
