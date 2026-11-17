---
impacto: capacidade_nova
secao: adicionado
titulo: Ollama (modelo local, sem chave) entra na lista de provedores de IA
---

Em IA › Credenciais, o provedor Ollama pede só o endereço do servidor (padrão `http://localhost:11434`) e, ao conectar, lê os modelos que ele tem baixados; "Atualizar modelos" pergunta de novo. Endereço local ou de rede interna só é aceito para o Ollama e só por quem tem papel admin; os outros provedores continuam exigindo endereço público com https. A atualização aplica a migration 0260 (aditiva) e não altera nenhuma credencial, ponto ou modelo já configurado.
