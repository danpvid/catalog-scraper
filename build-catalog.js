'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'dados');
const OUTPUT_HTML = path.join(ROOT_DIR, 'catalogo.html');

function readCards() {
  const cards = [];
  if (!fs.existsSync(DATA_DIR)) return cards;

  for (const companyDir of fs.readdirSync(DATA_DIR, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const dirPath = path.join(DATA_DIR, companyDir.name);
    const files = fs.readdirSync(dirPath).filter(file => file.endsWith('.js') && file !== '_index.js');

    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      try {
        delete require.cache[require.resolve(fullPath)];
        const card = require(fullPath);
        if (!card || isBotCard(card)) continue;
        cards.push({
          id: String(card.id_colnect || path.basename(file, '.js')),
          nome: clean(card.nome || path.basename(file, '.js')),
          operadora: clean(card.operadora_nome || card.operadora || companyDir.name.replace(/_/g, ' ')),
          operadoraDir: card.operadora_dir || companyDir.name,
          serie: clean(card.serie || card.propriedades?.['Série'] || card.propriedades?.Serie || ''),
          valor: clean(card.valor_facial || card.valor || ''),
          tiragem: clean(card.tiragem || ''),
          data: clean(card.data_emissao || card.ano || ''),
          tecnologia: clean(card.tecnologia || ''),
          fabricante: clean(card.fabricante || ''),
          temas: clean(card.temas || ''),
          numeroCatalogo: clean(card.numero_catalogo || ''),
          url: card.url_colnect || '',
          imagem: coverImagePath(card),
          imagens: localImagePaths(card),
          propriedades: card.propriedades || {},
        });
      } catch {
        // Dados antigos invalidos ficam fora do catalogo.
      }
    }
  }

  return cards.sort((a, b) =>
    a.operadora.localeCompare(b.operadora, 'pt-BR') || a.nome.localeCompare(b.nome, 'pt-BR')
  );
}

function isBotCard(card) {
  const text = `${card.nome || ''} ${Object.values(card.propriedades || {}).join(' ')}`;
  return /certificando de que voce nao e um bot|not a bot|making sure/i.test(
    text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  );
}

function coverImagePath(card) {
  const images = localImagePaths(card);
  const cover = images.find(image => image.tipo === 'full') || images[0];
  return cover ? cover.src : '';
}

function localImagePaths(card) {
  const companyDir = card.operadora_dir || '';
  const variants = Array.isArray(card.imagens_variantes_local) ? card.imagens_variantes_local : [];
  const fromVariants = variants
    .filter(image => image && image.arquivo)
    .map(image => ({
      src: `imagens/${encodePath(companyDir)}/${encodePath(image.arquivo)}`,
      tipo: image.tipo || '',
      lado: image.lado || '',
      bytes: image.bytes || 0,
    }));

  if (fromVariants.length) return fromVariants;

  const fallback = [];
  for (const image of card.imagens_local || []) {
    fallback.push({ src: `imagens/${encodePath(companyDir)}/${encodePath(image)}`, tipo: 'full', lado: '', bytes: 0 });
  }
  for (const image of card.imagens_high_local || []) {
    fallback.push({ src: `imagens/${encodePath(companyDir)}/${encodePath(image)}`, tipo: 'high', lado: '', bytes: 0 });
  }
  return fallback;
}

function encodePath(value) {
  return String(value).split('/').map(encodeURIComponent).join('/');
}

function clean(value) {
  return repairMojibake(String(value || '').replace(/\s+/g, ' ').trim());
}

function repairMojibake(value) {
  if (!/[ÃÂâ][\s\S]*|�/.test(value)) return value;
  const map = new Map([
    [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
    [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
    [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
    [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
    [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
    [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
    [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
  ]);
  const bytes = [];
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code <= 0xff) bytes.push(code);
    else if (map.has(code)) bytes.push(map.get(code));
    else return value;
  }
  const repaired = Buffer.from(bytes).toString('utf8');
  return repaired.includes('\uFFFD') ? value : repaired;
}

function buildHtml(cards) {
  const companies = [...new Set(cards.map(card => card.operadora))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const json = JSON.stringify({ cards, companies }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Catalogo de Cartoes Telefonicos do Brasil</title>
  <style>
    :root {
      --bg: #f7f5ef;
      --panel: #ffffff;
      --ink: #202124;
      --muted: #6d716f;
      --line: #ded8cc;
      --accent: #146c5f;
      --accent-strong: #0d4f45;
      --chip: #ece7dc;
      --shadow: 0 16px 40px rgba(34, 30, 22, .08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    header {
      position: sticky;
      top: 0;
      z-index: 20;
      border-bottom: 1px solid var(--line);
      background: rgba(247, 245, 239, .94);
      backdrop-filter: blur(14px);
    }
    .topbar {
      display: grid;
      grid-template-columns: 1fr minmax(240px, 420px);
      gap: 18px;
      align-items: center;
      max-width: 1440px;
      margin: 0 auto;
      padding: 18px 24px;
    }
    h1 {
      margin: 0;
      font-size: 21px;
      font-weight: 760;
      letter-spacing: 0;
    }
    .meta { color: var(--muted); font-size: 13px; margin-top: 3px; }
    .search {
      display: flex;
      align-items: center;
      gap: 10px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 12px;
      box-shadow: 0 4px 16px rgba(34, 30, 22, .04);
    }
    .search span { color: var(--muted); }
    input {
      width: 100%;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--ink);
      font-size: 15px;
      padding: 13px 0;
    }
    .layout {
      display: grid;
      grid-template-columns: 280px 1fr;
      gap: 24px;
      max-width: 1440px;
      margin: 0 auto;
      padding: 22px 24px 36px;
    }
    aside {
      position: sticky;
      top: 90px;
      align-self: start;
      max-height: calc(100vh - 112px);
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    .company {
      width: 100%;
      display: flex;
      justify-content: space-between;
      gap: 8px;
      border: 0;
      border-bottom: 1px solid #eee8dc;
      background: transparent;
      color: var(--ink);
      cursor: pointer;
      padding: 11px 13px;
      text-align: left;
      font: inherit;
    }
    .company:hover, .company.active { background: #eef5f1; color: var(--accent-strong); }
    .company small { color: var(--muted); }
    main { min-width: 0; }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
      color: var(--muted);
      font-size: 14px;
    }
    .clear {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--accent-strong);
      cursor: pointer;
      padding: 9px 12px;
      font-weight: 650;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
      gap: 16px;
    }
    .card {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      overflow: hidden;
      box-shadow: var(--shadow);
      cursor: pointer;
    }
    .thumb {
      display: grid;
      place-items: center;
      aspect-ratio: 4 / 3;
      background: #ebe6db;
      border-bottom: 1px solid var(--line);
    }
    .thumb img {
      max-width: 96%;
      max-height: 92%;
      object-fit: contain;
      filter: drop-shadow(0 8px 12px rgba(34, 30, 22, .14));
    }
    .placeholder {
      color: #8d8577;
      font-weight: 700;
      font-size: 13px;
      text-transform: uppercase;
    }
    .body { padding: 13px; }
    .name {
      display: -webkit-box;
      min-height: 42px;
      margin: 0 0 9px;
      overflow: hidden;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      font-size: 15px;
      font-weight: 750;
      line-height: 1.35;
    }
    .facts {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
    }
    .pill {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      border-radius: 999px;
      background: var(--chip);
      color: #4f514d;
      padding: 5px 8px;
      font-size: 12px;
    }
    dialog {
      width: min(920px, calc(100vw - 28px));
      border: 0;
      border-radius: 8px;
      padding: 0;
      box-shadow: 0 28px 80px rgba(0, 0, 0, .28);
    }
    dialog::backdrop { background: rgba(24, 25, 24, .5); }
    .modal {
      display: grid;
      grid-template-columns: minmax(260px, 42%) 1fr;
      max-height: min(760px, calc(100vh - 36px));
      background: var(--panel);
    }
    .modalImage {
      display: grid;
      place-items: center;
      min-height: 360px;
      background: #eee9df;
      border-right: 1px solid var(--line);
    }
    .modalImage img { max-width: 96%; max-height: 92%; object-fit: contain; }
    .gallery {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
      gap: 10px;
      margin: 18px 0;
    }
    .galleryItem {
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: #f5f1e8;
    }
    .galleryItem img {
      display: block;
      width: 100%;
      aspect-ratio: 4 / 3;
      object-fit: contain;
      background: #ebe6db;
    }
    .galleryItem div {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .modalBody { overflow: auto; padding: 20px; }
    .modalHead {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: start;
    }
    .modal h2 { margin: 0 0 6px; font-size: 22px; line-height: 1.22; }
    .close {
      border: 0;
      border-radius: 8px;
      background: #ece7dc;
      cursor: pointer;
      font-size: 18px;
      width: 38px;
      height: 38px;
      flex: 0 0 auto;
    }
    dl {
      display: grid;
      grid-template-columns: minmax(120px, 34%) 1fr;
      gap: 9px 14px;
      margin: 18px 0;
      font-size: 14px;
    }
    dt { color: var(--muted); }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .source {
      color: var(--accent-strong);
      font-weight: 700;
      text-decoration: none;
    }
    .empty {
      display: none;
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 44px;
      text-align: center;
      color: var(--muted);
      background: rgba(255, 255, 255, .6);
    }
    @media (max-width: 860px) {
      .topbar, .layout { grid-template-columns: 1fr; }
      aside { position: static; max-height: 240px; }
      .modal { grid-template-columns: 1fr; }
      .modalImage { min-height: 260px; border-right: 0; border-bottom: 1px solid var(--line); }
    }
  </style>
</head>
<body>
  <header>
    <div class="topbar">
      <div>
        <h1>Catalogo de Cartoes Telefonicos do Brasil</h1>
        <div class="meta"><span id="totalCards">0</span> cartoes em <span id="totalCompanies">0</span> operadoras</div>
      </div>
      <label class="search">
        <span>Buscar</span>
        <input id="search" type="search" autocomplete="off" placeholder="nome, serie, catalogo, tema">
      </label>
    </div>
  </header>
  <div class="layout">
    <aside id="companies"></aside>
    <main>
      <div class="toolbar">
        <div id="resultCount">0 resultados</div>
        <button class="clear" id="clear">Limpar filtros</button>
      </div>
      <section class="grid" id="grid"></section>
      <section class="empty" id="empty">Nenhum cartao encontrado.</section>
    </main>
  </div>
  <dialog id="dialog">
    <div class="modal">
      <div class="modalImage" id="modalImage"></div>
      <div class="modalBody">
        <div class="modalHead">
          <div>
            <h2 id="modalTitle"></h2>
            <div class="meta" id="modalCompany"></div>
          </div>
          <button class="close" id="close" aria-label="Fechar">x</button>
        </div>
        <div class="gallery" id="modalGallery"></div>
        <dl id="modalFacts"></dl>
        <a class="source" id="modalSource" target="_blank" rel="noreferrer">Abrir no Colnect</a>
      </div>
    </div>
  </dialog>
  <script>
    const DATA = ${json};
    const state = { company: '', query: '' };
    const byId = new Map(DATA.cards.map(card => [card.id, card]));
    const companyCounts = DATA.cards.reduce((acc, card) => {
      acc[card.operadora] = (acc[card.operadora] || 0) + 1;
      return acc;
    }, {});

    const companiesEl = document.getElementById('companies');
    const gridEl = document.getElementById('grid');
    const emptyEl = document.getElementById('empty');
    const resultCountEl = document.getElementById('resultCount');
    const searchEl = document.getElementById('search');
    const dialogEl = document.getElementById('dialog');

    document.getElementById('totalCards').textContent = DATA.cards.length.toLocaleString('pt-BR');
    document.getElementById('totalCompanies').textContent = DATA.companies.length.toLocaleString('pt-BR');

    function renderCompanies() {
      const all = buttonCompany('', 'Todas', DATA.cards.length);
      companiesEl.replaceChildren(all, ...DATA.companies.map(name => buttonCompany(name, name, companyCounts[name] || 0)));
    }

    function buttonCompany(value, label, count) {
      const button = document.createElement('button');
      button.className = 'company' + (state.company === value ? ' active' : '');
      button.innerHTML = '<span></span><small></small>';
      button.querySelector('span').textContent = label;
      button.querySelector('small').textContent = count.toLocaleString('pt-BR');
      button.addEventListener('click', () => {
        state.company = value;
        renderCompanies();
        renderCards();
      });
      return button;
    }

    function matches(card) {
      if (state.company && card.operadora !== state.company) return false;
      const query = state.query.trim().toLowerCase();
      if (!query) return true;
      return [card.nome, card.operadora, card.serie, card.numeroCatalogo, card.temas, card.valor]
        .join(' ')
        .toLowerCase()
        .includes(query);
    }

    function renderCards() {
      const filtered = DATA.cards.filter(matches);
      resultCountEl.textContent = filtered.length.toLocaleString('pt-BR') + ' resultados';
      emptyEl.style.display = filtered.length ? 'none' : 'block';
      gridEl.replaceChildren(...filtered.map(cardNode));
    }

    function cardNode(card) {
      const article = document.createElement('article');
      article.className = 'card';
      article.tabIndex = 0;
      article.dataset.id = card.id;
      article.innerHTML = \`
        <div class="thumb">\${card.imagem ? '<img loading="lazy" alt="">' : '<div class="placeholder">Sem imagem</div>'}</div>
        <div class="body">
          <h2 class="name"></h2>
          <div class="meta"></div>
          <div class="facts"></div>
        </div>\`;
      const img = article.querySelector('img');
      if (img) {
        img.src = card.imagem;
        img.alt = card.nome;
      }
      article.querySelector('.name').textContent = card.nome;
      article.querySelector('.meta').textContent = card.operadora;
      const facts = [card.serie, card.valor, card.data].filter(Boolean).slice(0, 3);
      article.querySelector('.facts').replaceChildren(...facts.map(text => {
        const pill = document.createElement('span');
        pill.className = 'pill';
        pill.textContent = text;
        return pill;
      }));
      article.addEventListener('click', () => openCard(card.id));
      article.addEventListener('keydown', event => {
        if (event.key === 'Enter') openCard(card.id);
      });
      return article;
    }

    function openCard(id) {
      const card = byId.get(id);
      if (!card) return;
      document.getElementById('modalTitle').textContent = card.nome;
      document.getElementById('modalCompany').textContent = card.operadora;
      const modalImage = document.getElementById('modalImage');
      modalImage.innerHTML = card.imagem ? '<img alt="">' : '<div class="placeholder">Sem imagem</div>';
      const img = modalImage.querySelector('img');
      if (img) {
        img.src = card.imagem;
        img.alt = card.nome;
      }
      const gallery = document.getElementById('modalGallery');
      gallery.replaceChildren(...(card.imagens || []).map(image => {
        const item = document.createElement('a');
        item.className = 'galleryItem';
        item.href = image.src;
        item.target = '_blank';
        item.rel = 'noreferrer';
        item.innerHTML = '<img loading="lazy" alt=""><div><span></span><span></span></div>';
        item.querySelector('img').src = image.src;
        item.querySelector('img').alt = card.nome + ' ' + image.tipo;
        item.querySelector('span:first-child').textContent = 'Lado ' + (image.lado || '-') + ' - ' + (image.tipo || 'imagem');
        item.querySelector('span:last-child').textContent = image.bytes ? Math.round(image.bytes / 1024) + ' KB' : '';
        return item;
      }));

      const rows = [
        ['ID Colnect', card.id],
        ['Serie', card.serie],
        ['Catalogo', card.numeroCatalogo],
        ['Valor facial', card.valor],
        ['Data', card.data],
        ['Tiragem', card.tiragem],
        ['Sistema', card.tecnologia],
        ['Fabricante', card.fabricante],
        ['Temas', card.temas],
      ].filter(row => row[1]);

      const facts = document.getElementById('modalFacts');
      facts.replaceChildren(...rows.flatMap(([label, value]) => {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        return [dt, dd];
      }));
      document.getElementById('modalSource').href = card.url;
      dialogEl.showModal();
    }

    document.getElementById('close').addEventListener('click', () => dialogEl.close());
    document.getElementById('clear').addEventListener('click', () => {
      state.company = '';
      state.query = '';
      searchEl.value = '';
      renderCompanies();
      renderCards();
    });
    searchEl.addEventListener('input', event => {
      state.query = event.target.value;
      renderCards();
    });

    renderCompanies();
    renderCards();
  </script>
</body>
</html>`;
}

const cards = readCards();
fs.writeFileSync(OUTPUT_HTML, buildHtml(cards), 'utf8');
console.log(`Catalogo gerado: ${OUTPUT_HTML}`);
console.log(`${cards.length} cartoes carregados.`);
