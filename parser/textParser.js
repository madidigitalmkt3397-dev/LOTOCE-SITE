// =====================================================================
// PARSER — COLAGEM MANUAL (Fase 3/4)
// Interpreta blocos no formato:
//   Extração Manhã
//   Dia 13/07/2026
//
//   1° PRÊMIO
//   8626
//   ...
// Nenhum dado é descartado silenciosamente: milhares inválidos e
// sessões não mapeadas são sinalizados, nunca convertidos por conta própria.
// =====================================================================

const SESSOES_OFICIAIS = ['MANHA', 'TARDE', 'NOITE'];

function normalizarTexto(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

// Valida e normaliza um milhar, preservando zero à esquerda (regra da seção 8/12)
function validarMilhar(valorBruto) {
  const limpo = (valorBruto || '').trim();
  if (!/^\d+$/.test(limpo)) {
    return { valid: false, number: null, error: `Milhar contém caracteres inválidos: "${valorBruto}"` };
  }
  if (limpo.length > 4) {
    return { valid: false, number: null, error: `Milhar com mais de 4 dígitos: "${valorBruto}"` };
  }
  const padded = limpo.padStart(4, '0');
  return { valid: true, number: padded, error: null, corrigido: padded !== limpo };
}

// Classifica a sessão contra a lista oficial (não converte silenciosamente — seção 7)
function classificarSessao(sessaoRaw, sessoesOficiais = SESSOES_OFICIAIS, aliasesConhecidos = {}) {
  if (!sessaoRaw) return { status: 'MISSING' };
  const norm = normalizarTexto(sessaoRaw);
  if (sessoesOficiais.includes(norm)) return { status: 'MAPPED', code: norm };
  if (aliasesConhecidos[norm]) return { status: 'MAPPED', code: aliasesConhecidos[norm], viaAlias: true };
  return { status: 'UNMAPPED', rawValue: sessaoRaw, normalized: norm };
}

function parseTextoColado(texto) {
  const linhas = (texto || '').split(/\r?\n/).map(l => l.trim());
  const regexPremio = /^(\d{1,2})[°º]?\s*PR[EÊ]MIO$/i;
  const regexDia = /^Dia\s+(\d{2}\/\d{2}\/\d{4})$/i;
  const regexExtracao = /^Extra[cç][aã]o\s+(.+)$/i;

  const blocos = [];
  let atual = null;
  let posicaoPendente = null;

  for (const raw of linhas) {
    if (!raw) continue;
    let m;

    if ((m = regexExtracao.exec(raw))) {
      if (atual) blocos.push(atual);
      atual = { sessaoRaw: m[1].trim(), data: null, itens: [] };
      posicaoPendente = null;
      continue;
    }
    if ((m = regexDia.exec(raw))) {
      if (!atual) atual = { sessaoRaw: null, data: null, itens: [] };
      atual.data = m[1];
      continue;
    }
    if ((m = regexPremio.exec(raw))) {
      posicaoPendente = parseInt(m[1], 10);
      continue;
    }
    if (posicaoPendente != null && atual) {
      const validacao = validarMilhar(raw);
      atual.itens.push({ position: posicaoPendente, rawValue: raw, ...validacao });
      posicaoPendente = null;
    }
  }
  if (atual) blocos.push(atual);
  return blocos;
}

// Monta a pré-visualização completa a partir dos blocos interpretados,
// aplicando a classificação de sessão a cada bloco.
function gerarPrevisualizacao(texto, aliasesConhecidos = {}) {
  const blocos = parseTextoColado(texto);
  const linhas = [];
  const sessoesNaoMapeadas = new Map();
  let validos = 0, invalidos = 0;

  blocos.forEach(bloco => {
    const sessaoInfo = classificarSessao(bloco.sessaoRaw, SESSOES_OFICIAIS, aliasesConhecidos);
    if (sessaoInfo.status === 'UNMAPPED' && !sessoesNaoMapeadas.has(sessaoInfo.normalized)) {
      sessoesNaoMapeadas.set(sessaoInfo.normalized, bloco.sessaoRaw);
    }
    bloco.itens.forEach(item => {
      if (item.valid) validos++; else invalidos++;
      linhas.push({
        data: bloco.data,
        sessaoRaw: bloco.sessaoRaw,
        sessaoStatus: sessaoInfo.status,
        sessaoCode: sessaoInfo.code || null,
        position: item.position,
        numero: item.number,
        valorOriginal: item.rawValue,
        corrigidoComZero: !!item.corrigido,
        valido: item.valid,
        erro: item.error
      });
    });
  });

  return {
    registrosEncontrados: linhas.length,
    registrosValidos: validos,
    registrosInvalidos: invalidos,
    sessoesNaoMapeadas: [...sessoesNaoMapeadas.entries()].map(([normalized, rawValue]) => ({ normalized, rawValue })),
    linhas
  };
}

module.exports = { normalizarTexto, validarMilhar, classificarSessao, parseTextoColado, gerarPrevisualizacao, SESSOES_OFICIAIS };
