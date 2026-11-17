# Instalação — CRM ALQUIM(IA)

A instalação é de um comando, pelo instalador, e o passo a passo está no [README](../README.md):

```bash
bash scripts/instalar.sh                                      # Linux, macOS, Git Bash
powershell -ExecutionPolicy Bypass -File scripts/instalar.ps1  # Windows
```

O instalador gera os segredos, sobe o Supabase local, aplica o `supabase/baseline.sql`, constrói as imagens e grava
tudo no `.env.local`. Não é preciso preencher chave nenhuma à mão para começar.

Cada variável que dá para ajustar está descrita em [`.env.example`](../.env.example). As opcionais (IA, e-mail,
integrações) ficam vazias e a parte correspondente do produto fica desligada até você preenchê-las.
