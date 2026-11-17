# Motor de disparo: terceira trava, a lista de destinos (`DISPARO_SO_PARA`)

Código em `lib/disparo/trava.ts` (regra pura), `lib/disparo/motor.ts` (aplica) e
`lib/disparo/envio-real.ts` (confere de novo, defesa em profundidade). Testes em
`lib/disparo/trava.test.ts` e `tests/unit/disparo-painel.test.ts`.

## Para que serve

O envio real já exige duas chaves: `disparo_config.modo = 'real'` na organização e
`DISPARO_REAL_LIBERADO=sim` no servidor. Na virada, o primeiro envio real tem de
sair só para o número do operador, sem risco de a fila de milhares de leads
começar a andar. Esta terceira trava, **opcional**, garante isso pelo servidor.

## Regra

- Variável de ambiente `DISPARO_SO_PARA`: números em E.164 separados por vírgula
  (ex.: `+5511999990000,+5521988887777`).
- **Não definida** (ausente, vazia ou só espaços): nada muda, o comportamento é o de sempre.
- **Definida**: o envio real só sai para os números da lista. Qualquer outro destino
  é barrado ANTES de chamar o canal: o envio vira `cancelado` com motivo
  `bloqueado_por_allowlist`. Não é erro, não tenta de novo, não freia o chip, não
  conta como falha e não cancela o resto da cadência do lead. O resumo do cron ganha
  o contador `bloqueadosAllowlist`.
- **Definida mas ilegível** (nenhum número válido): barra tudo. Quem escreveu a
  variável queria restringir; errar para o lado de não enviar é o certo.
- Comparação por dígitos, então `+55 (11) 99999-0000`, `11999990000` e
  `5511999990000` são o mesmo número. O nono dígito do celular brasileiro é
  ignorado na comparação (`55 11 9 9999-0000` = `55 11 9999-0000`).
- Só vale no envio **real**. Em modo simulado nada vai ao canal, com ou sem lista.
  A lista nunca abre a trava: sem as duas primeiras chaves, continua simulado.

## Por que `cancelado` e não um estado novo

`disparo_envios.estado` tem CHECK no banco. Um estado novo exigiria migration
tripla (arquivo, baseline, MANIFEST) só para um rótulo; o motivo
`bloqueado_por_allowlist` já identifica o caso em consulta e na tela, sem mexer no schema.

## Cuidado de operação

A abertura de um lead é única por lead (índice `disparo_envios_passo_unico`). Um lead
barrado pela lista fica com a abertura `cancelada` e o motor não a replaneja sozinho.
Por isso a lista serve para o ensaio do primeiro envio com a etapa de origem
contendo só o contato do operador. **Não** deixe a lista ligada com a fila inteira
de leads reais na etapa: o motor iria cancelando as aberturas deles uma a uma. Se
isso acontecer por engano, o motivo `bloqueado_por_allowlist` permite achar e
reabrir essas linhas.

## Na tela Disparo

O cartão de estado mostra uma linha: trava extra de destinos desligada ou ligada.
`GET /api/v1/disparo/estado` devolve `destinos_permitidos` (`null` = sem restrição;
número = quantos destinos a lista permite). Nunca os números.
