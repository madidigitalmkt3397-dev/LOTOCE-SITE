// =====================================================================
// LOTOCE QUANT INTELLIGENCE PLATFORM — SERVIDOR (FASES 1-3)
// Banco único PostgreSQL. Endpoints reais: nenhum botão decorativo.
// =====================================================================
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { Pool } = require('pg');
const { gerarPrevisualizacao, validarMilhar, classificarSessao, SESSOES_OFICIAIS } = require('./parser/textParser.js');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
async function registrarAuditoria(eventType, payload) {
  await pool.query('INSERT INTO audit_events (event_type, payload_json) VALUES ($1, $2)', [eventType, payload]);
}

async function carregarAliasesConhecidos() {
  const { rows } = await pool.query(
    `SELECT sa.raw_value, sc.code FROM session_aliases sa
     JOIN sessions_config sc ON sc.id = sa.session_id
     WHERE sa.decision = 'MAPPED'`
  );
  const mapa = {};
  rows.forEach(r => { mapa[r.raw_value.toUpperCase()] = r.code; });
  return mapa;
}

function eventDatetimeLogico(dataStr, sessionCode) {
  // dataStr no formato DD/MM/AAAA. Sem horário oficial disponível na colagem manual,
  // usa ordenação lógica MANHA < TARDE < NOITE (registrando a origem, seção 19).
  const [d, m, a] = dataStr.split('/');
  const horaLogica = { MANHA: '09:00:00', TARDE: '14:00:00', NOITE: '19:00:00' }[sessionCode] || '12:00:00';
  return `${a}-${m}-${d}T${horaLogica}`;
}

// ---------------------------------------------------------------------
// FASE 3/4 — COLAGEM MANUAL: pré-visualização (não grava nada ainda)
// ---------------------------------------------------------------------
app.post('/api/import/paste/preview', async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto || !texto.trim()) return res.status(400).json({ erro: 'Nenhum texto informado.' });

    const aliasesConhecidos = await carregarAliasesConhecidos();
    const preview = gerarPrevisualizacao(texto, aliasesConhecidos);

    // checa duplicidade contra o banco para as linhas válidas e com sessão já mapeada
    for (const linha of preview.linhas) {
      if (!linha.valido || linha.sessaoStatus !== 'MAPPED' || !linha.data) continue;
      const { rows } = await pool.query(
        `SELECT dr.number FROM draws d
         JOIN draw_results dr ON dr.draw_id = d.id
         JOIN sessions_config sc ON sc.id = d.session_id
         WHERE d.draw_date = to_date($1,'DD/MM/YYYY') AND sc.code = $2 AND dr.position = $3`,
        [linha.data, linha.sessaoCode, linha.position]
      );
      linha.duplicado = rows.length > 0;
      linha.valorExistente = rows.length > 0 ? rows[0].number : null;
    }

    const job = await pool.query(
      `INSERT INTO import_jobs (kind, raw_payload, records_found, records_valid, records_invalid, duplicates_found, errors_json)
       VALUES ('MANUAL_PASTE', $1, $2, $3, $4, $5, $6) RETURNING id`,
      [texto, preview.registrosEncontrados, preview.registrosValidos, preview.registrosInvalidos,
       preview.linhas.filter(l => l.duplicado).length,
       JSON.stringify(preview.linhas.filter(l => !l.valido))]
    );

    res.json({ importJobId: job.rows[0].id, ...preview });
  } catch (e) {
    res.status(500).json({ erro: 'Falha ao processar pré-visualização.', detalhe: e.message });
  }
});

// ---------------------------------------------------------------------
// FASE 3 — COLAGEM MANUAL: confirmação (grava de fato no banco)
// ---------------------------------------------------------------------
app.post('/api/import/paste/confirm', async (req, res) => {
  const client = await pool.connect();
  try {
    const { importJobId, texto, mapeamentosSessao = {}, sobrescreverDuplicados = false } = req.body;
    const aliasesConhecidos = await carregarAliasesConhecidos();
    const preview = gerarPrevisualizacao(texto, aliasesConhecidos);

    await client.query('BEGIN');

    // Resolve sessões não mapeadas conforme decisão explícita do usuário nesta confirmação
    for (const naoMapeada of preview.sessoesNaoMapeadas) {
      const decisao = mapeamentosSessao[naoMapeada.rawValue]; // 'MANHA' | 'TARDE' | 'NOITE' | 'NEW' | 'IGNORE'
      if (!decisao) continue; // segue não mapeada, linhas correspondentes não serão gravadas

      let sessionId;
      if (decisao === 'NEW') {
        const codeNovo = naoMapeada.normalized.replace(/\s+/g, '_');
        const r = await client.query(
          `INSERT INTO sessions_config (code, label, sort_order) VALUES ($1,$2, (SELECT COALESCE(MAX(sort_order),0)+1 FROM sessions_config))
           ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
          [codeNovo, naoMapeada.rawValue]
        );
        sessionId = r.rows[0].id;
      } else if (decisao === 'IGNORE') {
        await client.query(
          `INSERT INTO session_aliases (raw_value, session_id, decision) VALUES ($1, NULL, 'IGNORED') ON CONFLICT (raw_value) DO NOTHING`,
          [naoMapeada.rawValue]
        );
        continue;
      } else {
        const r = await client.query('SELECT id FROM sessions_config WHERE code = $1', [decisao]);
        sessionId = r.rows[0].id;
        await client.query(
          `INSERT INTO session_aliases (raw_value, session_id, decision) VALUES ($1, $2, 'MAPPED') ON CONFLICT (raw_value) DO NOTHING`,
          [naoMapeada.rawValue, sessionId]
        );
      }
      // aplica a decisão às linhas deste lote
      preview.linhas.forEach(l => {
        if (l.sessaoRaw === naoMapeada.rawValue) {
          l.sessaoStatus = 'MAPPED';
          l.sessaoCode = decisao === 'NEW' ? naoMapeada.normalized.replace(/\s+/g, '_') : decisao;
        }
      });
    }

    // agrupa por (data, sessão) para criar um draw por grupo
    const grupos = new Map();
    preview.linhas.forEach(l => {
      if (!l.valido || l.sessaoStatus !== 'MAPPED' || !l.data) return;
      const chave = `${l.data}|${l.sessaoCode}`;
      if (!grupos.has(chave)) grupos.set(chave, []);
      grupos.get(chave).push(l);
    });

    let inseridos = 0, ignoradosPorDuplicidade = 0;

    for (const [chave, linhas] of grupos) {
      const [data, sessionCode] = chave.split('|');
      const sessaoRow = await client.query('SELECT id FROM sessions_config WHERE code = $1', [sessionCode]);
      if (!sessaoRow.rows.length) continue;
      const sessionId = sessaoRow.rows[0].id;

      const drawExistente = await client.query(
        `SELECT id FROM draws WHERE draw_date = to_date($1,'DD/MM/YYYY') AND session_id = $2`,
        [data, sessionId]
      );

      let drawId;
      if (drawExistente.rows.length) {
        drawId = drawExistente.rows[0].id;
      } else {
        const novoDraw = await client.query(
          `INSERT INTO draws (draw_date, session_id, event_datetime, temporal_source, source, import_job_id)
           VALUES (to_date($1,'DD/MM/YYYY'), $2, $3, 'LOGICAL_SESSION_ORDER', 'MANUAL_PASTE', $4) RETURNING id`,
          [data, sessionId, eventDatetimeLogico(data, sessionCode), importJobId]
        );
        drawId = novoDraw.rows[0].id;
      }

      for (const l of linhas) {
        const existente = await client.query(
          'SELECT number FROM draw_results WHERE draw_id = $1 AND position = $2', [drawId, l.position]
        );
        if (existente.rows.length) {
          if (!sobrescreverDuplicados) { ignoradosPorDuplicidade++; continue; }
          await client.query('UPDATE draw_results SET number = $1 WHERE draw_id = $2 AND position = $3',
            [l.numero, drawId, l.position]);
        } else {
          await client.query('INSERT INTO draw_results (draw_id, position, number) VALUES ($1,$2,$3)',
            [drawId, l.position, l.numero]);
        }
        inseridos++;
      }
    }

    await client.query(`UPDATE import_jobs SET status='CONFIRMED', confirmed_at=now() WHERE id=$1`, [importJobId]);
    await client.query('COMMIT');

    await registrarAuditoria('IMPORT', { importJobId, inseridos, ignoradosPorDuplicidade, kind: 'MANUAL_PASTE' });
    res.json({ ok: true, inseridos, ignoradosPorDuplicidade });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ erro: 'Falha ao confirmar importação.', detalhe: e.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// FASE 2 — IMPORTAÇÃO EXCEL: pré-visualização
// Espera colunas reconhecíveis (data, sessão, posição/prêmio, milhar).
// Aceita tanto uma aba única com as três sessões quanto arquivos separados.
// ---------------------------------------------------------------------
app.post('/api/import/excel/preview', upload.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const aliasesConhecidos = await carregarAliasesConhecidos();

    const linhasTotais = [];
    wb.SheetNames.forEach(nomeAba => {
      const planilha = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, defval: '' });
      // detecta cabeçalho pela primeira linha não vazia com termos conhecidos
      const header = planilha[0].map(h => String(h).trim().toUpperCase());
      const idxData = header.findIndex(h => h.includes('DATA') || h.includes('DIA'));
      const idxSessao = header.findIndex(h => h.includes('SESS') || h.includes('EXTRA'));
      const idxPosicao = header.findIndex(h => h.includes('POSI') || h.includes('PR')); // "PRÊMIO"
      const idxMilhar = header.findIndex(h => h.includes('MILHAR') || h.includes('N') || h.includes('NUM'));

      if (idxData === -1 || idxSessao === -1 || idxMilhar === -1) {
        linhasTotais.push({ erroEstrutura: `Aba "${nomeAba}": não consegui identificar as colunas de data/sessão/milhar automaticamente.` });
        return;
      }

      for (let i = 1; i < planilha.length; i++) {
        const linha = planilha[i];
        if (!linha || linha.every(c => c === '')) continue;
        const dataRaw = String(linha[idxData] || '').trim();
        const sessaoRaw = String(linha[idxSessao] || '').trim();
        const posicaoRaw = idxPosicao !== -1 ? String(linha[idxPosicao] || '').trim() : '';
        const milharRaw = String(linha[idxMilhar] || '').trim();

        const sessaoInfo = classificarSessao(sessaoRaw, SESSOES_OFICIAIS, aliasesConhecidos);
        const validacao = validarMilhar(milharRaw);

        linhasTotais.push({
          aba: nomeAba, data: dataRaw, sessaoRaw, sessaoStatus: sessaoInfo.status, sessaoCode: sessaoInfo.code || null,
          position: parseInt(posicaoRaw, 10) || null, numero: validacao.number, valorOriginal: milharRaw,
          corrigidoComZero: !!validacao.corrigido, valido: validacao.valid, erro: validacao.error
        });
      }
    });

    const validos = linhasTotais.filter(l => l.valido).length;
    const invalidos = linhasTotais.filter(l => l.valido === false).length;
    const sessoesNaoMapeadas = [...new Set(linhasTotais.filter(l => l.sessaoStatus === 'UNMAPPED').map(l => l.sessaoRaw))]
      .map(rawValue => ({ rawValue }));

    const job = await pool.query(
      `INSERT INTO import_jobs (kind, original_filename, records_found, records_valid, records_invalid, errors_json)
       VALUES ('EXCEL', $1, $2, $3, $4, $5) RETURNING id`,
      [req.file.originalname, linhasTotais.length, validos, invalidos, JSON.stringify(linhasTotais.filter(l => l.valido === false))]
    );

    res.json({ importJobId: job.rows[0].id, registrosEncontrados: linhasTotais.length, registrosValidos: validos,
      registrosInvalidos: invalidos, sessoesNaoMapeadas, linhas: linhasTotais });
  } catch (e) {
    res.status(500).json({ erro: 'Falha ao processar o Excel.', detalhe: e.message });
  }
});

// ---------------------------------------------------------------------
// HISTÓRICO
// ---------------------------------------------------------------------
app.get('/api/draws', async (req, res) => {
  const { dataInicio, dataFim, sessao, limit = 100 } = req.query;
  const condicoes = [];
  const params = [];
  if (dataInicio) { params.push(dataInicio); condicoes.push(`d.draw_date >= $${params.length}`); }
  if (dataFim) { params.push(dataFim); condicoes.push(`d.draw_date <= $${params.length}`); }
  if (sessao) { params.push(sessao); condicoes.push(`sc.code = $${params.length}`); }
  const where = condicoes.length ? 'WHERE ' + condicoes.join(' AND ') : '';
  params.push(parseInt(limit, 10) || 100);

  const { rows } = await pool.query(
    `SELECT d.id, d.draw_date, sc.code AS sessao, d.event_datetime, d.temporal_source,
            json_agg(json_build_object('position', dr.position, 'number', dr.number) ORDER BY dr.position) AS resultados
     FROM draws d
     JOIN sessions_config sc ON sc.id = d.session_id
     JOIN draw_results dr ON dr.draw_id = d.id
     ${where}
     GROUP BY d.id, sc.code
     ORDER BY d.event_datetime DESC
     LIMIT $${params.length}`,
    params
  );
  res.json(rows);
});

// ---------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LotoCE backend rodando na porta ${PORT}`));
