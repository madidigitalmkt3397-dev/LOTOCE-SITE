# LotoCE Quant Intelligence Platform — Fases 1-3

Implementação real das Fases 1-3 do prompt: banco único (PostgreSQL), importação de Excel,
colagem manual, parser com validação e pré-visualização antes de gravar.

**O que é real aqui:** todos os botões estão conectados a endpoints de verdade, que gravam
no PostgreSQL. Nada é decorativo. `957` vira `0957` automaticamente. Sessões desconhecidas
(ex: "Tarde II") são sinalizadas para você decidir, nunca convertidas sozinhas.

## 1. Banco de dados (grátis, permanente)

1. Crie uma conta grátis em **neon.tech** (ou supabase.com)
2. Crie um novo projeto/banco Postgres
3. Copie a **connection string** (algo como `postgresql://usuario:senha@host/banco?sslmode=require`)
4. Rode o schema:
   ```
   npm install
   DATABASE_URL="sua_connection_string" npm run migrate
   ```

## 2. Rodar localmente (opcional, pra testar antes de publicar)

```
npm install
DATABASE_URL="sua_connection_string" npm start
```

Abra `http://localhost:3000`.

## 3. Publicar grátis (Render — Web Service, não Static Site)

1. Suba esta pasta inteira num repositório novo no GitHub
2. No Render: **New → Web Service** (não "Static Site" — esse projeto precisa rodar um servidor)
3. Conecte o repositório
4. **Build Command:** `npm install`
5. **Start Command:** `node server.js`
6. Em **Environment Variables**, adicione `DATABASE_URL` com a connection string do Neon/Supabase
7. Create Web Service

## O que ainda falta (Fases 4-13 do prompt original)

Este pacote cobre bancode dados + importação + colagem + parser/validação (Fases 1-4).
As fases seguintes (análise temporal curto/médio/longo, backtesting, walk-forward,
engines de Bayes/Markov/ML, consenso, previsões congeladas, auditoria completa) são
um projeto de desenvolvimento contínuo — recomendo continuar num ambiente como o
Claude Code, que consegue manter o projeto todo versionado e ir construindo fase a
fase com testes reais a cada etapa, em vez de tentar gerar tudo de uma vez num chat.
