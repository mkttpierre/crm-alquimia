/**
 * A leitura inteira da base (`carregarLeads`) tem teto de 20 mil linhas por tabela. Passou dele, a leitura falha com este erro
 * tipado: a tela mostra o erro de sempre, e a exportação (que só chega aqui com o filtro de intervalo ativo) responde 422 com
 * uma mensagem que diz o que fazer, em vez de um 500 genérico.
 */
export class LimiteDeLeituraExcedido extends Error {
  constructor() {
    super("Limite de leitura de leads excedido");
    this.name = "LimiteDeLeituraExcedido";
  }
}
