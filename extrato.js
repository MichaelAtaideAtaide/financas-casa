/* Finanças da Casa — leitura de extratos (PDF, OFX, CSV/texto) e classificação automática.
   Tudo roda no aparelho: o arquivo do extrato não é enviado para nenhum servidor. */
(function () {
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  // valores como "-R$ 1.100,00", "R$ 84,93", "-84,93", "1.234,56 D"
  const moneyRe = /(-)?\s*(?:R\s*\$\s*)?(-)?(\d{1,3}(?:\.\d{3})*,\d{2})(?!\d)(\s*[DC]\b)?/g;
  const dataRe = /^(\d{2})\/(\d{2})\/(\d{2,4})\b/;
  const brData = s => { const m = s.match(/(\d{2})\/(\d{2})\/(\d{2,4})/); if (!m) return null; const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2]}-${m[1]}`; };
  function valores(l) {
    const out = [];
    for (const m of l.matchAll(moneyRe)) {
      let v = parseFloat(m[3].replace(/\./g, '').replace(',', '.'));
      if (m[1] || m[2] || (m[4] && /D/.test(m[4]))) v = -v;
      out.push(v);
    }
    return out;
  }
  const semValores = l => l.replace(dataRe, '').replace(moneyRe, '').replace(/\s+/g, ' ').trim();
  const RUIDO = /^(data\s+(descricao|historico|lancamento)|detalhe dos movimentos|extrato( de conta)?\b|(segunda|terca|quarta|quinta|sexta|sabado|domingo)(-feira)?\s*,|\d+\s*\/\s*\d+$|saldo (anterior|do dia|inicial|final|disponivel)\b|total\b|lancamentos futuros)/;

  /* ---------- PDF → linhas de texto ---------- */
  async function pdfParaLinhas(buf) {
    const lib = window.pdfjsLib;
    if (!lib) throw new Error('leitor de PDF indisponível');
    lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    const doc = await lib.getDocument({ data: buf }).promise;
    const linhas = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const pg = await doc.getPage(p);
      const tc = await pg.getTextContent();
      const rows = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const x = it.transform[4], y = it.transform[5];
        let r = rows.find(r => Math.abs(r.y - y) < 2.5);
        if (!r) { r = { y, items: [] }; rows.push(r); }
        r.items.push({ x, s: it.str });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) { r.items.sort((a, b) => a.x - b.x); linhas.push(r.items.map(i => i.s).join(' ').replace(/R\s+\$/g, 'R$').replace(/\s+/g, ' ').trim()); }
    }
    return linhas;
  }

  /* ---------- linhas → movimentos ---------- */
  function parseLinhas(L) {
    const meta = {};
    L.forEach((l, i) => {
      const n = norm(l);
      if (/^nome\s*:/.test(n) && !meta.nome) meta.nome = l.split(':').slice(1).join(':').trim();
      const ag = l.match(/Ag[êe]ncia:?\s*([\d-]+).*?Conta:?\s*([\d.\-\/]+)/i);
      if (ag && !meta.conta) { meta.agencia = ag[1]; meta.conta = ag[2]; }
      const pe = l.match(/Per[íi]odo:?\s*(\d{2}\/\d{2}\/\d{4})\s*a\s*(\d{2}\/\d{2}\/\d{4})/i);
      if (pe && !meta.fim) { meta.inicio = brData(pe[1]); meta.fim = brData(pe[2]); }
      if (/saldo inicial/i.test(l) && /saldo final/i.test(l)) {
        const vs = valores(L[i + 1] || '');
        if (vs.length >= 2) { meta.saldoInicial = vs[0]; meta.saldoFinal = vs[vs.length - 1]; }
      }
    });
    const temCabecalho = L.some(l => /detalhe dos movimentos/i.test(l));
    let ativo = !temCabecalho;
    const blocos = []; let pend = [];
    for (const l of L) {
      const n = norm(l);
      if (/detalhe dos movimentos/.test(n)) { ativo = true; continue; }
      if (!ativo) continue;
      if (RUIDO.test(n)) continue;
      const dm = l.match(dataRe), vs = dm ? valores(l) : [];
      if (dm && vs.length) {
        const y = dm[3].length === 2 ? '20' + dm[3] : dm[3];
        blocos.push({ antes: pend, data: `${y}-${dm[2]}-${dm[1]}`, valor: vs[0], saldo: vs.length > 1 ? vs[vs.length - 1] : null, mesma: semValores(l) });
        pend = [];
      } else pend.push(l);
    }
    const sobra = pend;
    // quantas linhas de descrição vêm antes da data: aprende com o primeiro movimento
    const k = blocos.length ? Math.min(blocos[0].antes.length, 2) : 0;
    const txs = blocos.map((b, i) => {
      const antes = b.antes.slice(Math.max(0, b.antes.length - k));
      const prox = i + 1 < blocos.length ? blocos[i + 1].antes : sobra;
      const depois = prox.slice(0, Math.max(0, prox.length - (i + 1 < blocos.length ? k : 0))).slice(0, 2);
      const tipo = [...antes, b.mesma].filter(Boolean).join(' ').trim();
      return { data: b.data, valor: b.valor, saldo: b.saldo, tipo, detalhe: depois.join(' ').trim() };
    });
    if (meta.saldoFinal == null && txs.length) {
      const ult = txs.filter(t => t.saldo != null).sort((a, b) => b.data.localeCompare(a.data))[0];
      if (ult) meta.saldoFinal = ult.saldo;
    }
    if (!meta.fim && txs.length) meta.fim = txs.map(t => t.data).sort().pop();
    return { txs, meta };
  }

  function parseOFX(t) {
    const txs = [], meta = {};
    for (const b of t.split(/<STMTTRN>/i).slice(1)) {
      const g = tag => { const m = b.match(new RegExp('<' + tag + '>([^<\\r\\n]*)', 'i')); return m ? m[1].trim() : ''; };
      const d = g('DTPOSTED'), v = parseFloat(g('TRNAMT').replace(',', '.'));
      if (!d || isNaN(v)) continue;
      txs.push({ data: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, valor: v, saldo: null, tipo: g('NAME') || g('TRNTYPE'), detalhe: g('MEMO'), fitid: g('FITID') });
    }
    const bal = t.match(/<LEDGERBAL>[\s\S]*?<BALAMT>([^<\r\n]+)[\s\S]*?<DTASOF>(\d{8})/i);
    if (bal) { meta.saldoFinal = parseFloat(bal[1].replace(',', '.')); meta.fim = `${bal[2].slice(0, 4)}-${bal[2].slice(4, 6)}-${bal[2].slice(6, 8)}`; }
    const acct = t.match(/<ACCTID>([^<\r\n]+)/i); if (acct) meta.conta = acct[1].trim();
    if (!meta.fim && txs.length) meta.fim = txs.map(x => x.data).sort().pop();
    return { txs, meta };
  }

  async function lerArquivo(file) {
    const nome = (file.name || '').toLowerCase();
    if (nome.endsWith('.pdf') || file.type === 'application/pdf') return parseLinhas(await pdfParaLinhas(await file.arrayBuffer()));
    const txt = await file.text();
    if (/<OFX>|<STMTTRN>/i.test(txt)) return parseOFX(txt);
    return parseLinhas(txt.split(/\r?\n/).map(l => l.replace(/[;\t]/g, ' ').trim()).filter(Boolean));
  }

  /* ---------- classificação ---------- */
  // [padrão, categoria, subcategoria]; a primeira que casar vence
  const REGRAS = [
    [/juros.*(saldo|limite|cheque|especial|utiliz)|juros (cheque|limite|conta)|encargos.*(limite|cheque)/, 'Juros e tarifas bancárias', 'Juros do cheque especial'],
    [/\biof\b/, 'Juros e tarifas bancárias', 'IOF'],
    [/tarifa|cesta (de )?servico|pacote de servico|anuidade|manutencao (de )?conta|taxa (de )?(saque|manutencao)/, 'Juros e tarifas bancárias', 'Tarifas bancárias'],
    [/sao paulo transporte|sptrans|bilhete unico|\bmetro\b|cptm|\buber\b|\b99 ?(app|pop|taxi)?\b|cabify|posto|combust|shell|ipiranga|petrobras|\bbr mania|estac|estacionamento|\bpark\b|zona azul|sem parar|conectcar|veloe|pedagio/, 'Transporte', ''],
    [/carrefour|pao de acucar|\bextra\b|assai|atacadao|\bdia (supermercado|brasil)|supermerc|mercado(?! ?(livre|pago))|hortifruti|\boba\b|sonda|st marche|emporio|bio mundo|quitanda|acougue|sacolao|natural da terra|minuto pa|swift/, 'Mercado', ''],
    [/restaurante|lanchon|lanchonete|picanharia|churrasc|pizza|burger|hamburg|mc ?donald|bk |subway|ifood|rappi|ze delivery|gelato|sorvet|\bcafe\b|coffee|padaria|panificadora|confeitaria|doceria|bistro|baoba|sushi|temaki|bar e|boteco|outback|madero|starbucks|cafeteria|coupcafe/, 'Restaurantes e delivery', ''],
    [/drogasil|droga raia|drogaria|farmacia|pague menos|panvel|onofre|hospital|clinica|laboratorio|fleury|odonto|dentista|unimed|amil|bradesco saude|sulamerica/, 'Saúde', ''],
    [/\bsesc\b|cinema|cinemark|ingresso|teatro|show|museu|parque|clube|kinoplex|sympla|eventim/, 'Lazer', ''],
    [/netflix|spotify|disney|hbo|\bmax\b|prime video|amazon prime|youtube|deezer|globoplay|apple\.com|icloud|google (one|storage)|paramount|chatgpt|openai|claude|anthropic/, 'Assinaturas', ''],
    [/cosmetic|perfum|boticario|natura|sephora|salao|barbearia|cabeleir|manicure|estetica|kiko/, 'Cuidados pessoais', ''],
    [/amazon|mercado ?livre|shopee|magalu|magazine luiza|americanas|renner|riachuelo|c ?& ?a\b|zara|centauro|netshoes|decathlon|aliexpress|shein|livraria|kalunga/, 'Compras pessoais', ''],
    [/enel|eletropaulo|light |cemig|copel|sabesp|comgas|naturgy|vivo|claro|\btim\b|\boi\b|net servicos|internet|condominio/, 'Contas da casa', ''],
    [/escola|colegio|faculdade|universidade|curso|mensalidade escolar|material escolar|udemy|alura/, 'Educação', ''],
    [/aluguel|imobiliaria|quinto andar|quintoandar/, 'Moradia', ''],
    [/ipva|iptu|detran|licenciamento|darf|receita federal|multa|tributo|imposto/, 'Impostos e taxas', ''],
    [/seguro/, 'Seguros', ''],
    [/aplicacao|investimento|tesouro|cdb|lci|lca|corretora|previdencia/, 'Investimentos', ''],
    [/emprestimo|financiamento|parcela (do )?(emprestimo|financiamento)|consorcio/, 'Dívidas e parcelas', ''],
  ];
  const REGRAS_RECEITA = [
    [/salario|folha|pagamento de salario|vencimento|provento|remuneracao mensal/, 'Salário', ''],
    [/rendimento|remuneracao (de )?aplicacao|juros (recebidos|sobre)|dividendo/, 'Rendimentos', ''],
  ];
  const ehTransfer = n => /\bpix\b|\bted\b|\bdoc\b|transf/.test(n);
  const pareceNome = s => { const n = norm(s); return n.split(' ').length >= 2 && !/\d|ltda|\bme\b|eireli|\bs\/?a\b|servicos|comercio|loja|restaurante|mercado|brasil|park|cafe/.test(n); };
  function chave(tx) { const base = norm(tx.detalhe && !/^periodo/i.test(tx.detalhe) ? tx.detalhe : tx.tipo); return (ehTransfer(norm(tx.tipo)) ? 'pix:' : '') + base; }
  function descricao(tx) {
    const d = (tx.detalhe || '').trim(), t = (tx.tipo || '').trim();
    if (d && !/^periodo/i.test(d)) return d;
    return d ? `${t} (${d.replace(/^per[ií]odo:?\s*/i, '')})` : t;
  }
  function classificar(tx, ctx) {
    const existe = n => ctx.cats.some(c => c.nome === n);
    const k = chave(tx), n = norm(tx.tipo + ' ' + (tx.detalhe || ''));
    const dono = norm(ctx.nome || '').split(' ')[0];
    if (ctx.regras && ctx.regras[k]) { const r = ctx.regras[k]; return { ...r, conf: 'aprendida', motivo: 'Você já classificou este item assim' }; }
    if (ehTransfer(norm(tx.tipo)) && dono && norm(tx.detalhe).startsWith(dono)) return { cat: '', sub: '', ignorar: true, conf: 'transferencia', motivo: 'Transferência para você mesmo: não é receita nem despesa' };
    if (tx.valor > 0) {
      if (/estorno|devolucao|reembolso|cancelamento/.test(n)) { for (const [re, cat, sub] of REGRAS) if (re.test(n) && existe(cat)) return { cat, sub, estorno: true, conf: 'sugerida', motivo: 'Estorno: reduz a despesa da categoria' }; return { cat: existe('Outras despesas') ? 'Outras despesas' : '', sub: '', estorno: true, conf: 'revisar', motivo: 'Estorno sem categoria clara' }; }
      for (const [re, cat, sub] of REGRAS_RECEITA) if (re.test(n) && existe(cat)) return { cat, sub, conf: 'sugerida', motivo: 'Entrada identificada pela descrição' };
      return { cat: existe('Renda extra') && ehTransfer(n) ? 'Renda extra' : (existe('Outras receitas') ? 'Outras receitas' : ''), sub: '', conf: 'revisar', motivo: 'Entrada de dinheiro: confira a origem' };
    }
    for (const [re, cat, sub] of REGRAS) if (re.test(n)) {
      if (existe(cat) || ctx.criaveis.includes(cat)) return { cat, sub, conf: 'sugerida', motivo: 'Identificado pelo nome do estabelecimento' };
    }
    if (ehTransfer(norm(tx.tipo)) && pareceNome(tx.detalhe)) return { cat: 'Transferências e Pix', sub: '', conf: 'sugerida', motivo: 'Pix ou transferência para outra pessoa' };
    if (ctx.historico && ctx.historico[k]) return { ...ctx.historico[k], conf: 'aprendida', motivo: 'Igual a um lançamento que você já fez' };
    return { cat: existe('Outras despesas') ? 'Outras despesas' : '', sub: '', conf: 'revisar', motivo: 'Não reconheci o estabelecimento: escolha a categoria' };
  }
  function idMov(tx) { return 'ext-' + [tx.data, tx.valor.toFixed(2), norm(tx.tipo + '|' + (tx.detalhe || '')), tx.saldo == null ? (tx.fitid || '') : tx.saldo.toFixed(2)].join('|').replace(/[^a-z0-9|.,-]/g, '').slice(0, 120); }

  window.Extrato = { lerArquivo, parseLinhas, parseOFX, pdfParaLinhas, classificar, chave, descricao, idMov, norm };
})();
