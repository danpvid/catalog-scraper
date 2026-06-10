'use strict';

const cheerio = require('cheerio');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const BASE_URL = 'https://colnect.com';
const COMPANIES_URL = `${BASE_URL}/pt/phonecards/companies/country/30-Brasil`;
const OUTPUT_DIR = __dirname;
const DATA_DIR = path.join(OUTPUT_DIR, 'dados');
const IMAGES_DIR = path.join(OUTPUT_DIR, 'imagens');
const MAX_RETRIES = 3;
const TIMEOUT_MS = 45000;
// UA atualizado para Chrome 131 (mesma versao do Playwright bundled)
const UA_FULL = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const USER_AGENT = UA_FULL;

const args = parseArgs(process.argv.slice(2));
const FILTER_OPERADORA = args.operadora || null;
const LIMIT_CARDS = args.limite ? Number.parseInt(args.limite, 10) : null;
const DOWNLOAD_IMAGES = !args.semImagens;
const DOWNLOAD_HIGH_IMAGES = DOWNLOAD_IMAGES && !args.semHigh;
const REFRESH = !!args.refresh;
const REFRESH_LINKS = !!args.refreshLinks || REFRESH;
const COMPANIES_HTML = args.fromHtml || null;
const LIST_HTML = args.listHtml || null;
// headless=false por padrão para o browser ficar visível e resolver Anubis
const HEADLESS = args.headless === 'true';
// Aguarda o usuário fazer login manual antes de iniciar o scraping
const AWAIT_LOGIN = !!args.aguardarLogin;
// Sessão global do Playwright (fica aberta durante toda a extração)
let BROWSER = null;
let CTX = null;
let PAGE = null;
let COMPANIES_HTML_CONTENT = null;
const DELAY_MIN_MS = parsePositiveInt(args.delayMin || args.delayMs, 4500);
const DELAY_MAX_MS = Math.max(parsePositiveInt(args.delayMax || args.delayMs, 9000), DELAY_MIN_MS);
const PAGE_PAUSE_EVERY = parsePositiveInt(args.pagePauseEvery, 8);
const PAGE_PAUSE_MIN_MS = parsePositiveInt(args.pagePauseMin, 45000);
const PAGE_PAUSE_MAX_MS = Math.max(parsePositiveInt(args.pagePauseMax, 120000), PAGE_PAUSE_MIN_MS);
const STATE_FILE = path.join(OUTPUT_DIR, '_estado_scraper.json');
const PLACEHOLDER_HASHES_FILE = path.join(OUTPUT_DIR, '_placeholder_hashes.json');
const BLOCKED_IMAGES_FILE = path.join(OUTPUT_DIR, '_imagens_bloqueadas.json');
// Mínimo de cartões distintos com o mesmo hash para considerar placeholder automático
const PLACEHOLDER_AUTO_THRESHOLD = 3;

const IMAGE_VARIANTS = [
  { key: 'thumb', pathPart: 't', suffix: '_thumb' },
  { key: 'full', pathPart: 'f', suffix: '' },
  { key: 'high', pathPart: 'b', suffix: '_high' },
  { key: 'original', pathPart: 'o', suffix: '_original' },
];

let lastRequestAt = 0;
// Página mais recente carregada (para log)
let lastPageLoaded = '';

// ─── Detecção de imagem placeholder ("Iniciar Sessão") ───────────────────────
// Mapa: hash -> Set de id_colnect que baixaram aquela imagem nesta sessão
const hashCardMap = new Map();
// Hashes confirmados como placeholder (carregados do arquivo + detectados na sessão)
// Hash embutido: retângulo preto vertical (4928b) — confirmado em 12.932 cartões
let knownPlaceholderHashes = new Set([
  'd812f4defbdb2f9ff7084505226c0878607145436f59a3df1524d9ab88ebb867',
]);

function loadPlaceholderHashes() {
  try {
    if (!fs.existsSync(PLACEHOLDER_HASHES_FILE)) return;
    const data = JSON.parse(fs.readFileSync(PLACEHOLDER_HASHES_FILE, 'utf8'));
    if (Array.isArray(data.hashes)) {
      for (const h of data.hashes) knownPlaceholderHashes.add(h);
    }
    log(`Placeholder hashes carregados: ${knownPlaceholderHashes.size}`);
  } catch {
    // Ignora erros de leitura
  }
}

function savePlaceholderHashes() {
  try {
    const data = {
      atualizado_em: new Date().toISOString(),
      total: knownPlaceholderHashes.size,
      hashes: [...knownPlaceholderHashes],
    };
    writeJsonFile(PLACEHOLDER_HASHES_FILE, data);
  } catch {
    // Ignora erros de escrita
  }
}

function computeHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Registra o hash de uma imagem baixada para o cartão `cardId`.
 * Se o hash já for conhecido como placeholder, retorna true imediatamente.
 * Caso contrário, verifica se atingiu o limiar automático.
 * @returns {boolean} true se a imagem é um placeholder
 */
function trackImageHash(hash, cardId) {
  if (knownPlaceholderHashes.has(hash)) return true;

  if (!hashCardMap.has(hash)) hashCardMap.set(hash, new Set());
  hashCardMap.get(hash).add(String(cardId));

  if (hashCardMap.get(hash).size >= PLACEHOLDER_AUTO_THRESHOLD) {
    log(`  Placeholder detectado automaticamente (hash ${hash.slice(0, 12)}..., ${hashCardMap.get(hash).size} cartoes).`);
    knownPlaceholderHashes.add(hash);
    savePlaceholderHashes();
    return true;
  }

  return false;
}

// ─── Registro global de imagens bloqueadas ───────────────────────────────────
function loadBlockedImages() {
  return readJsonFile(BLOCKED_IMAGES_FILE, { atualizado_em: null, total: 0, cartoes: [] });
}

function saveBlockedImages(registry) {
  registry.atualizado_em = new Date().toISOString();
  registry.total = registry.cartoes.length;
  writeJsonFile(BLOCKED_IMAGES_FILE, registry);
}

function registerBlockedCard(card, company, pageUrl) {
  const registry = loadBlockedImages();
  const existing = registry.cartoes.findIndex(c => String(c.id_colnect) === String(card.id_colnect));
  const entry = {
    id_colnect: card.id_colnect,
    nome: card.nome,
    url_colnect: card.url_colnect,
    operadora: company.name,
    operadora_dir: sanitize(company.name),
    pagina_lista: pageUrl || '',
    registrado_em: new Date().toISOString(),
  };
  if (existing >= 0) {
    registry.cartoes[existing] = entry;
  } else {
    registry.cartoes.push(entry);
  }
  saveBlockedImages(registry);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const LOG_FILE = fs.createWriteStream(path.join(OUTPUT_DIR, '_log_extracao.txt'), { flags: 'a' });

function log(message) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${now}] ${message}`;
  console.log(line);
  LOG_FILE.write(line + '\n');
}

function sanitize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 110) || 'sem_nome';
}

function cleanText(value) {
  return repairMojibake(String(value || ''))
    .replace(/\s+/g, ' ')
    .replace(/\s+:/g, ':')
    .trim();
}

function repairMojibake(value) {
  if (!/[ÃÂâ][\s\S]*|�/.test(value)) return value;

  const windows1252 = new Map([
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
    if (code <= 0xff) {
      bytes.push(code);
    } else if (windows1252.has(code)) {
      bytes.push(windows1252.get(code));
    } else {
      return value;
    }
  }

  const repaired = Buffer.from(bytes).toString('utf8');
  return repaired.includes('\uFFFD') ? value : repaired;
}

function absoluteUrl(href, base = BASE_URL) {
  if (!href) return '';
  if (href.startsWith('//')) return `https:${href}`;
  return new URL(href, base).toString();
}

function decodeBody(buffer, contentType) {
  const charset = String(contentType || '').match(/charset=([^;]+)/i)?.[1]?.toLowerCase();
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    return repairMojibake(buffer.toString('latin1'));
  }
  return repairMojibake(buffer.toString('utf8'));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function waitForRateLimit() {
  const requestDelay = randomInt(DELAY_MIN_MS, DELAY_MAX_MS);
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < requestDelay) await delay(requestDelay - elapsed);
  lastRequestAt = Date.now();
}

// ─── Comportamento humano simulado ───────────────────────────────────────────
async function humanScroll(page) {
  const steps = randomInt(2, 5);
  for (let i = 0; i < steps; i++) {
    await page.evaluate(y => window.scrollBy(0, y), randomInt(120, 400));
    await delay(randomInt(200, 600));
  }
}

async function humanMouseMove(page) {
  const x = randomInt(120, 1100);
  const y = randomInt(120, 700);
  await page.mouse.move(x, y, { steps: randomInt(4, 10) }).catch(() => {});
}

async function humanPause() {
  // Simula tempo de "leitura" da página
  await delay(randomInt(1200, 3500));
}

// ─── Fetch de página HTML via Playwright (sessão persistente) ────────────────
async function fetchPage(targetUrl) {
  if (!PAGE) await initSession();
  await waitForRateLimit();

  // Comportamento humano esporádico
  if (Math.random() < 0.4) await humanMouseMove(PAGE);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await PAGE.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 75000 });
      lastPageLoaded = targetUrl;

      // Aguarda um pouco antes de checar o conteúdo (Anubis precisa de tempo)
      await delay(randomInt(800, 2000));
      let html = await PAGE.content();

      // Se Anubis aparecer, aguarda resolução automática (até 3 min)
      if (isChallengePage(html)) {
        log('  Anubis detectado. Aguardando resolucao automatica...');
        for (let i = 0; i < 60; i++) {
          await delay(3000);
          html = await PAGE.content();
          if (!isChallengePage(html)) { log(`  Anubis resolvido em ${(i + 1) * 3}s.`); break; }
        }
      }

      if (isChallengePage(html)) throw new ChallengeError('Anubis nao resolveu.');

      const status = response?.status() ?? 200;
      if ([429, 503].includes(status) && attempt < MAX_RETRIES) {
        const waitMs = randomInt(30000, 60000);
        log(`  HTTP ${status}. Aguardando ${Math.round(waitMs / 1000)}s...`);
        await delay(waitMs);
        continue;
      }

      // Scroll humano depois de carregar
      await humanScroll(PAGE);
      await humanPause();

      return { status, body: html, url: targetUrl };
    } catch (e) {
      if (e instanceof ChallengeError) throw e;
      if (attempt < MAX_RETRIES) {
        const browserClosed = e.message && (
          e.message.includes('browser has been closed') ||
          e.message.includes('context has been closed') ||
          e.message.includes('Target closed') ||
          e.message.includes('Session closed')
        );
        log(`  Erro ao carregar (${e.message.slice(0, 70)}). Tentativa ${attempt}/${MAX_RETRIES}...`);
        if (browserClosed) {
          log('  Browser fechado detectado. Reiniciando sessao Playwright...');
          await initSession();
        } else {
          await ensureWarp();
          await delay(randomInt(3000, 6000));
        }
        continue;
      }
      throw e;
    }
  }
}

// Alias para manter compatibilidade com chamadas fetchUrl existentes
async function fetchUrl(targetUrl, options = {}) {
  if (options.binary) return fetchImage(targetUrl);
  return fetchPage(targetUrl);
}

// ─── Fetch de imagem via contexto do Playwright (compartilha cookies/sessão) ─
async function fetchImage(imageUrl) {
  if (!CTX) await initSession();
  try {
    const response = await CTX.request.fetch(absoluteUrl(imageUrl), {
      headers: {
        'Referer': BASE_URL,
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      timeout: TIMEOUT_MS,
    });
    if (!response.ok()) return { status: response.status(), body: Buffer.alloc(0), headers: {} };
    const body = await response.body();
    const contentType = response.headers()['content-type'] || '';
    return { status: response.status(), body, headers: { 'content-type': contentType } };
  } catch (e) {
    const browserClosed = e.message && (
      e.message.includes('browser has been closed') ||
      e.message.includes('context has been closed') ||
      e.message.includes('Target closed')
    );
    if (browserClosed) {
      log('  Browser fechado durante download de imagem. Reiniciando sessao...');
      await initSession();
      // Tenta novamente após reiniciar
      try {
        const r2 = await CTX.request.fetch(absoluteUrl(imageUrl), {
          headers: { 'Referer': BASE_URL, 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
          timeout: TIMEOUT_MS,
        });
        if (!r2.ok()) return { status: r2.status(), body: Buffer.alloc(0), headers: {} };
        const body = await r2.body();
        return { status: r2.status(), body, headers: { 'content-type': r2.headers()['content-type'] || '' } };
      } catch {}
    }
    return { status: 0, body: Buffer.alloc(0), headers: {} };
  }
}

function isChallengePage(html) {
  const text = cleanText(html);
  return /certificando de que voce nao e um bot|making sure|not a bot|anubis|checking your browser/i.test(
    text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  );
}

// ─── Erro especial para desafio Anubis ───────────────────────────────────────
class ChallengeError extends Error {
  constructor(message) { super(message); this.name = 'ChallengeError'; }
}

// ─── Reconecta o WARP ────────────────────────────────────────────────────────
async function ensureWarp() {
  const warpPath = 'C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe';
  const { execSync } = require('child_process');
  if (!fs.existsSync(warpPath)) return;

  try { execSync(`"${warpPath}" disconnect`, { stdio: 'ignore', timeout: 6000 }); } catch {}
  await new Promise(r => setTimeout(r, 2000));
  try { execSync(`"${warpPath}" connect`, { stdio: 'ignore', timeout: 10000 }); } catch {}

  log('  Aguardando WARP conectar...');
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const out = execSync(`"${warpPath}" status`, { encoding: 'utf8', timeout: 5000 });
      if (out.includes('Connected')) break;
    } catch {}
  }
  await new Promise(r => setTimeout(r, 5000));
  log('  WARP reconectado.');
}

// ─── Abre Chromium e mantém aberto para toda a sessão ────────────────────────
async function initSession() {
  // Fecha sessão anterior se houver
  if (BROWSER) {
    try { await BROWSER.close(); } catch {}
    BROWSER = null; CTX = null; PAGE = null;
    COMPANIES_HTML_CONTENT = null;
  }

  await ensureWarp();

  const { chromium } = require('playwright');
  log('Browser: abrindo sessao Playwright (ficara aberto durante toda a extracao)...');

  BROWSER = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--no-proxy-server', // força WireGuard do WARP no nível do SO
    ],
  });

  CTX = await BROWSER.newContext({
    userAgent: USER_AGENT,
    viewport: { width: randomInt(1200, 1400), height: randomInt(800, 950) },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });

  PAGE = await CTX.newPage();

  // Máscara anti-detecção
  await PAGE.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    const orig = window.navigator.permissions.query;
    window.navigator.permissions.query = params =>
      params.name === 'notifications' ? Promise.resolve({ state: 'denied' }) : orig(params);
  });

  // Aguarda o túnel WireGuard ser visível para o processo Chromium
  await PAGE.waitForTimeout(4000);

  // Navega para a página inicial com retry
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await PAGE.goto(COMPANIES_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
      break;
    } catch (e) {
      if (attempt < 3) {
        log(`  goto falhou (${attempt}/3). Reconectando WARP...`);
        await ensureWarp();
        await PAGE.waitForTimeout(4000);
      } else {
        await BROWSER.close();
        BROWSER = null; CTX = null; PAGE = null;
        throw e;
      }
    }
  }

  // Aguarda Anubis resolver (máx 3 min)
  for (let i = 0; i < 60; i++) {
    const body = await PAGE.textContent('body').catch(() => '');
    if (isChallengePage(body)) {
      log(`  Anubis ativo (${i * 3}s)...`);
      await PAGE.waitForTimeout(3000);
    } else { break; }
  }

  // Comportamento humano inicial: scroll e pausa
  await humanScroll(PAGE);
  await humanPause();

  // Salva HTML das operadoras (já estamos na página certa)
  COMPANIES_HTML_CONTENT = await PAGE.content();
  log('  Sessao iniciada. Browser permanece aberto.');

  // Se solicitado, aguarda login manual do usuário antes de prosseguir
  if (AWAIT_LOGIN) {
    log('');
    log('========================================================');
    log('  AGUARDANDO LOGIN MANUAL');
    log('  Faca login no Colnect no browser aberto.');
    log('  Depois volte aqui e pressione ENTER para continuar.');
    log('========================================================');
    await new Promise(resolve => {
      process.stdin.setRawMode(false);
      process.stdin.resume();
      process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
    });
    log('  Login confirmado. Retomando scraping...');
    // Recarrega a página principal após login para capturar HTML autenticado
    await PAGE.goto(COMPANIES_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await humanScroll(PAGE);
    await humanPause();
    COMPANIES_HTML_CONTENT = await PAGE.content();
  }
}

async function getCompanies() {
  // Usa o HTML já capturado durante o initSession (browser já estava na página)
  let html = COMPANIES_HTML
    ? fs.readFileSync(path.resolve(OUTPUT_DIR, COMPANIES_HTML), 'utf8')
    : (COMPANIES_HTML_CONTENT || (await fetchPage(COMPANIES_URL)).body);

  if (isChallengePage(html)) {
    log('Anubis detectado em getCompanies. Reiniciando sessao...');
    await initSession();
    html = COMPANIES_HTML_CONTENT || '';
    if (isChallengePage(html) || !html) throw new Error('Anubis persistente apos re-autenticacao.');
  }

  const $ = cheerio.load(html);
  const companies = [];
  $('a.country_flag[href*="/phonecards/series/country/30-Brasil/company/"]').each((_, element) => {
    const href = $(element).attr('href');
    const label = cleanText($(element).text());
    const countMatch = label.match(/\(([\d.,]+)\)\s*$/);
    const name = label.replace(/\s*\([\d.,]+\)\s*$/, '').trim();
    const count = countMatch ? Number.parseInt(countMatch[1].replace(/\D/g, ''), 10) : null;
    if (!name || !href) return;
    companies.push({
      name,
      totalInformado: count,
      href: absoluteUrl(href.replace('/phonecards/series/', '/phonecards/list/')),
    });
  });

  return companies;
}

function buildPageUrl(listUrl, pageNumber) {
  if (pageNumber <= 1) return listUrl;
  if (/\/page\/\d+/.test(listUrl)) return listUrl.replace(/\/page\/\d+/, `/page/${pageNumber}`);
  return `${listUrl.replace(/\/$/, '')}/page/${pageNumber}`;
}

function parseCardList(html, listUrl) {
  if (isChallengePage(html)) {
    throw new ChallengeError('Anubis detectado na listagem.');
  }

  const $ = cheerio.load(html);
  const cards = [];
  const seen = new Set();

  $('#plist_items .pl-it').each((_, element) => {
    const item = $(element);
    const link = item.find('h2.item_header a[href*="/phonecards/phonecard/"], a[href*="/phonecards/phonecard/"]').first();
    const href = absoluteUrl(link.attr('href'), listUrl);
    const id = href.match(/\/phonecard\/(\d+)/)?.[1] || '';
    if (!href || !id || seen.has(id)) return;

    const name = cleanText(link.text() || link.attr('title') || item.find('img[alt]').first().attr('alt') || `Cartao ${id}`);
    const props = {};
    item.find('dl dt').each((__, dt) => {
      const key = cleanText($(dt).text()).replace(/:$/, '');
      const value = cleanText($(dt).next('dd').text());
      if (key && value && !/login to see complete item details/i.test(value)) props[key] = value;
    });

    const images = [];
    item.find('img').each((__, img) => {
      for (const attr of ['data-src', 'data-lazy-src', 'data-original', 'src']) {
        const raw = $(img).attr(attr);
        if (!raw || raw.startsWith('data:')) continue;
        const normalized = normalizeImageUrl(raw);
        if (normalized && !images.includes(normalized)) images.push(normalized);
      }
    });

    seen.add(id);
    cards.push(normalizeCard({
      id_colnect: id,
      url_colnect: href,
      nome: name,
      propriedades: props,
      imagens: images,
      imagem_thumb: images[0] || '',
    }));
  });

  if (cards.length === 0) {
    $('a[href*="/phonecards/phonecard/"]').each((_, element) => {
      const href = absoluteUrl($(element).attr('href'), listUrl);
      const id = href.match(/\/phonecard\/(\d+)/)?.[1] || '';
      if (!id || seen.has(id)) return;
      seen.add(id);
      cards.push(normalizeCard({
        id_colnect: id,
        url_colnect: href,
        nome: cleanText($(element).text() || $(element).attr('title') || `Cartao ${id}`),
        propriedades: {},
        imagens: [],
        imagem_thumb: '',
      }));
    });
  }

  const pageNumbers = [];
  $('.pager_wrapper a[data-page]').each((_, element) => {
    const page = Number.parseInt($(element).attr('data-page'), 10);
    if (Number.isFinite(page)) pageNumbers.push(page);
  });

  return {
    cards,
    lastPage: pageNumbers.length ? Math.max(...pageNumbers) : 1,
  };
}

function normalizeImageUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(absoluteUrl(rawUrl));
  } catch {
    return '';
  }
  if (parsed.hostname.toLowerCase() !== 'i.colnect.net') return '';
  if (/favicon|sprite|pixel|blank|avatar/i.test(parsed.pathname)) return '';
  parsed.pathname = parsed.pathname.replace('/t/', '/f/');
  return parsed.toString();
}

function normalizeCard(card) {
  const props = card.propriedades || {};
  const normalized = { ...card, propriedades: props };
  const fieldMap = {
    'Pais': 'pais',
    'País': 'pais',
    'Empresa': 'operadora',
    'Companhia': 'operadora',
    'Serie': 'serie',
    'Série': 'serie',
    'Cod. de Catalogo': 'numero_catalogo',
    'Cód. de Catálogo': 'numero_catalogo',
    'Valor facial': 'valor_facial',
    'Valor Facial': 'valor_facial',
    'Data de emissao': 'data_emissao',
    'Data de emissão': 'data_emissao',
    'Ano': 'ano',
    'Exemplares emitidos': 'tiragem',
    'Tiragem': 'tiragem',
    'Prazo de validade': 'prazo_validade',
    'Validade': 'validade',
    'Composicao': 'composicao',
    'Composição': 'composicao',
    'Sistema': 'tecnologia',
    'Tecnologia': 'tecnologia',
    'Fabricante': 'fabricante',
    'Temas': 'temas',
    'Descricao': 'descricao',
    'Descrição': 'descricao',
    'Pontuacao': 'pontuacao',
    'Pontuação': 'pontuacao',
  };

  for (const [label, key] of Object.entries(fieldMap)) {
    if (props[label] && !normalized[key]) normalized[key] = props[label];
  }

  return normalized;
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  const temp = `${filePath}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temp, filePath);
  } catch {
    // Fallback: escreve diretamente se o rename falhar
    try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8'); } catch {}
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
  }
}

function loadState() {
  return readJsonFile(STATE_FILE, { started_at: new Date().toISOString(), companies: {} });
}

function saveState(state) {
  state.updated_at = new Date().toISOString();
  writeJsonFile(STATE_FILE, state);
}

function linkCachePath(dataDir) {
  return path.join(dataDir, '_links.json');
}

function loadLinkCache(dataDir, company) {
  const fallback = {
    operadora: company.name,
    href: company.href,
    complete: false,
    lastPageFetched: 0,
    lastPageKnown: null,
    cards: [],
  };
  const cache = readJsonFile(linkCachePath(dataDir), fallback);
  if (cache.href !== company.href || cache.operadora !== company.name) return fallback;
  cache.cards = Array.isArray(cache.cards) ? cache.cards : [];
  return cache;
}

function saveLinkCache(dataDir, cache) {
  cache.updated_at = new Date().toISOString();
  writeJsonFile(linkCachePath(dataDir), cache);
}

async function maybeLongPagePause(pageNumber) {
  if (!PAGE_PAUSE_EVERY || pageNumber % PAGE_PAUSE_EVERY !== 0) return;
  const pauseMs = randomInt(PAGE_PAUSE_MIN_MS, PAGE_PAUSE_MAX_MS);
  log(`  Pausa de ${Math.round(pauseMs / 1000)}s apos ${pageNumber} paginas.`);
  await delay(pauseMs);
}

async function getCardsForCompany(company, dataDir) {
  const cache = loadLinkCache(dataDir, company);
  const cards = [...cache.cards];
  const seen = new Set(cards.map(card => String(card.id_colnect)));
  let pageNumber = REFRESH_LINKS ? 1 : cache.lastPageFetched + 1;
  let lastPage = REFRESH_LINKS ? 1 : (cache.lastPageKnown || Math.max(cache.lastPageFetched + 1, 1));

  if (cache.complete && !REFRESH_LINKS && !LIST_HTML) {
    log(`  Usando cache de links: ${cards.length} cartoes.`);
    return LIMIT_CARDS ? cards.slice(0, LIMIT_CARDS) : cards;
  }

  if (REFRESH_LINKS) {
    cache.complete = false;
    cache.lastPageFetched = 0;
    cache.lastPageKnown = null;
    cache.cards = [];
    cards.length = 0;
    seen.clear();
  }

  let challengeRetries = 0;
  while (pageNumber <= lastPage) {
    const pageUrl = buildPageUrl(company.href, pageNumber);
    log(`  Lista p.${pageNumber}: ${pageUrl}`);

    const html = LIST_HTML && pageNumber === 1
      ? fs.readFileSync(path.resolve(OUTPUT_DIR, LIST_HTML), 'utf8')
      : (await fetchUrl(pageUrl)).body;

    let parsed;
    try {
      parsed = parseCardList(html, pageUrl);
    } catch (e) {
      if (e instanceof ChallengeError && challengeRetries < 2) {
        challengeRetries += 1;
        log(`  Anubis detectado. Reiniciando sessao (tentativa ${challengeRetries}/2)...`);
        await initSession();
        continue; // retenta a mesma página
      }
      throw e;
    }
    challengeRetries = 0;
    lastPage = Math.max(lastPage, parsed.lastPage);
    cache.lastPageKnown = lastPage;

    for (const card of parsed.cards) {
      if (seen.has(card.id_colnect)) continue;
      seen.add(card.id_colnect);
      cards.push(card);
    }

    cache.cards = cards;
    cache.lastPageFetched = pageNumber;
    cache.complete = !LIMIT_CARDS && (pageNumber >= lastPage || parsed.cards.length === 0 || !!LIST_HTML);
    saveLinkCache(dataDir, cache);

    if (LIMIT_CARDS && cards.length >= LIMIT_CARDS) return cards.slice(0, LIMIT_CARDS);
    if (parsed.cards.length === 0) break;
    await maybeLongPagePause(pageNumber);
    pageNumber += 1;
  }

  cache.cards = cards;
  cache.complete = !LIMIT_CARDS;
  saveLinkCache(dataDir, cache);
  return LIMIT_CARDS ? cards.slice(0, LIMIT_CARDS) : cards;
}

function readExistingCards(dataDir) {
  const existing = new Map();
  if (!fs.existsSync(dataDir)) return existing;

  for (const file of fs.readdirSync(dataDir).filter(name => name.endsWith('.js') && name !== '_index.js')) {
    const fullPath = path.join(dataDir, file);
    try {
      delete require.cache[require.resolve(fullPath)];
      const data = require(fullPath);
      if (data && data.id_colnect) existing.set(String(data.id_colnect), { data, path: fullPath });
    } catch {
      // Arquivos antigos ou corrompidos sao ignorados na retomada.
    }
  }

  return existing;
}

async function downloadImages(card, imageDir, baseFileName, existingData) {
  if (!DOWNLOAD_IMAGES) {
    return {
      normal: existingData?.imagens_local || [],
      high: existingData?.imagens_high_local || [],
      variants: existingData?.imagens_variantes_local || [],
      hasPlaceholder: false,
    };
  }

  const localImages = [];
  const highImages = [];
  const variants = [];
  let hasPlaceholder = false;

  for (let index = 0; index < card.imagens.length; index += 1) {
    const imageUrl = card.imagens[index];
    const extension = extensionFromUrl(imageUrl);
    const sideSuffix = index === 0 ? '' : `_v${index + 1}`;

    for (const variant of IMAGE_VARIANTS) {
      if (!DOWNLOAD_HIGH_IMAGES && ['high', 'original'].includes(variant.key)) continue;

      const fileName = `${baseFileName}${sideSuffix}${variant.suffix}.${extension}`;
      const destination = path.join(imageDir, fileName);
      const variantUrl = imageVariantUrl(imageUrl, variant.pathPart);
      const downloaded = await downloadImageVariant(variantUrl, destination, card.id_colnect);

      if (downloaded?.placeholder) {
        hasPlaceholder = true;
        continue;
      }

      if (downloaded) {
        variants.push({
          lado: index + 1,
          tipo: variant.key,
          arquivo: fileName,
          url: variantUrl,
          bytes: downloaded.bytes,
        });
        if (variant.key === 'full') localImages.push(fileName);
        if (variant.key === 'high') highImages.push(fileName);
        log(`    imagem ${variant.key}: ${fileName}`);
      }
    }
  }

  return {
    normal: localImages.length ? localImages : (existingData?.imagens_local || []),
    high: highImages.length ? highImages : (existingData?.imagens_high_local || []),
    variants: variants.length ? variants : (existingData?.imagens_variantes_local || []),
    hasPlaceholder,
  };
}

function extensionFromUrl(imageUrl) {
  return imageUrl.match(/\.(jpe?g|png|gif|webp)(?:\?|$)/i)?.[1]?.toLowerCase().replace('jpeg', 'jpg') || 'jpg';
}

function imageVariantUrl(imageUrl, pathPart) {
  const parsed = new URL(absoluteUrl(imageUrl));
  parsed.pathname = parsed.pathname.replace(/\/[tfbo]\//, `/${pathPart}/`);
  return parsed.toString();
}

async function downloadImageVariant(url, destination, cardId) {
  const temp = `${destination}.tmp`;

  if (fs.existsSync(destination) && fs.statSync(destination).size > 100) {
    // Verifica se a imagem já salva é um placeholder
    const existing = fs.readFileSync(destination);
    const hash = computeHash(existing);
    if (cardId && trackImageHash(hash, cardId)) {
      // Apaga a imagem placeholder que foi salva anteriormente
      try { fs.unlinkSync(destination); } catch {}
      return { placeholder: true };
    }
    return { bytes: existing.length, existed: true };
  }

  try {
    const response = await fetchImage(url);
    const contentType = String(response.headers['content-type'] || '');
    if (response.status !== 200 || !contentType.startsWith('image/') || response.body.length < 100) return null;

    const hash = computeHash(response.body);
    if (cardId && trackImageHash(hash, cardId)) {
      log(`    imagem bloqueada (placeholder detectado): ${path.basename(destination)}`);
      return { placeholder: true };
    }

    fs.writeFileSync(temp, response.body);
    fs.renameSync(temp, destination);
    return { bytes: response.body.length, existed: false };
  } catch (error) {
    log(`    falha imagem (${url}): ${error.message}`);
    return null;
  } finally {
    if (fs.existsSync(temp)) try { fs.unlinkSync(temp); } catch {}
  }
}

function writeCard(dataDir, card, existingEntry) {
  const baseFileName = `${card.id_colnect}_${sanitize(card.nome)}`;
  const filePath = existingEntry?.path || path.join(dataDir, `${baseFileName}.js`);
  fs.writeFileSync(filePath, `module.exports = ${JSON.stringify(card, null, 2)};\n`, 'utf8');
  return { filePath, baseFileName: path.basename(filePath, '.js') };
}

function writeIndex(dataDir, companyName) {
  const cards = fs.readdirSync(dataDir)
    .filter(file => file.endsWith('.js') && file !== '_index.js')
    .map(file => path.basename(file, '.js'))
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));

  fs.writeFileSync(
    path.join(dataDir, '_index.js'),
    `module.exports = ${JSON.stringify({ operadora: companyName, total: cards.length, cartoes: cards }, null, 2)};\n`,
    'utf8'
  );
}

function isCardComplete(data, sourceCard = null) {
  if (!data) return false;
  // Cartões com imagem bloqueada nunca são considerados completos — serão retentados
  if (data.imagem_bloqueada) return false;
  if (!DOWNLOAD_IMAGES) return true;
  const expectedImages = Math.max(
    Array.isArray(sourceCard?.imagens) ? sourceCard.imagens.length : 0,
    Array.isArray(data.imagens) ? data.imagens.length : 0
  );
  if (expectedImages === 0) return true;
  const hasNormal = Array.isArray(data.imagens_local) && data.imagens_local.length > 0 && data.imagem_principal;
  if (!DOWNLOAD_HIGH_IMAGES) return hasNormal;
  const hasHigh = hasNormal && Array.isArray(data.imagens_high_local) && data.imagens_high_local.length > 0 && data.imagem_high_principal;
  const expectedVariants = expectedImages * IMAGE_VARIANTS.length;
  const hasVariants = Array.isArray(data.imagens_variantes_local) && data.imagens_variantes_local.length >= expectedVariants;
  return hasHigh && hasVariants;
}

async function processCompany(company, state) {
  const companyDir = sanitize(company.name);
  const dataDir = path.join(DATA_DIR, companyDir);
  const imageDir = path.join(IMAGES_DIR, companyDir);
  ensureDir(dataDir);
  ensureDir(imageDir);

  log(`\n=== ${company.name} ===`);
  state.companies[company.name] = {
    ...(state.companies[company.name] || {}),
    status: 'running',
    started_at: state.companies[company.name]?.started_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  saveState(state);

  const existing = readExistingCards(dataDir);
  const cards = await getCardsForCompany(company, dataDir);
  let saved = 0;
  let skipped = 0;
  let errors = 0;

  for (const card of cards) {
    const existingEntry = existing.get(String(card.id_colnect));
    if (existingEntry && !REFRESH && isCardComplete(existingEntry.data, card)) {
      skipped += 1;
      continue;
    }

    try {
      const baseFileName = existingEntry
        ? path.basename(existingEntry.path, '.js')
        : `${card.id_colnect}_${sanitize(card.nome)}`;
      const downloaded = await downloadImages(card, imageDir, baseFileName, existingEntry?.data);
      const finalCard = {
        ...existingEntry?.data,
        ...card,
        imagens_local: downloaded.normal,
        imagem_principal: downloaded.normal[0] || '',
        imagens_high_local: downloaded.high,
        imagem_high_principal: downloaded.high[0] || '',
        imagens_variantes_local: downloaded.variants,
        imagem_bloqueada: downloaded.hasPlaceholder || false,
        operadora_nome: company.name,
        operadora_dir: companyDir,
        extraido_em: new Date().toISOString(),
      };
      writeCard(dataDir, finalCard, existingEntry);

      if (downloaded.hasPlaceholder) {
        registerBlockedCard(card, company, company.href);
        log(`  Cartao ${card.id_colnect} marcado como imagem bloqueada.`);
      }

      saved += 1;
      state.companies[company.name].last_card_id = card.id_colnect;
      state.companies[company.name].salvos = (state.companies[company.name].salvos || 0) + 1;
      state.companies[company.name].updated_at = new Date().toISOString();
      saveState(state);
    } catch (error) {
      errors += 1;
      log(`  ERRO ${card.id_colnect}: ${error.message}`);
    }
  }

  writeIndex(dataDir, company.name);
  state.companies[company.name] = {
    ...state.companies[company.name],
    status: errors ? 'completed_with_errors' : 'completed',
    total_listado: cards.length,
    salvos_no_ciclo: saved,
    ignorados_no_ciclo: skipped,
    erros_no_ciclo: errors,
    finished_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  saveState(state);
  return { operadora: company.name, total_listado: cards.length, salvos: saved, ignorados: skipped, erros: errors };
}

async function main() {
  ensureDir(DATA_DIR);
  ensureDir(IMAGES_DIR);

  loadPlaceholderHashes();
  log(`Saida: ${OUTPUT_DIR}`);
  log(`Imagens: ${DOWNLOAD_IMAGES ? 'sim' : 'nao'}`);
  log(`Imagens high: ${DOWNLOAD_HIGH_IMAGES ? 'sim' : 'nao'}`);
  log(`Delay entre requests: ${DELAY_MIN_MS}-${DELAY_MAX_MS}ms`);
  log(`Pausa longa: a cada ${PAGE_PAUSE_EVERY} paginas por ${PAGE_PAUSE_MIN_MS}-${PAGE_PAUSE_MAX_MS}ms`);
  log(`Limite por operadora: ${LIMIT_CARDS || 'sem limite'}`);

  const state = loadState();
  saveState(state);

  await initSession();

  let companies = await getCompanies();
  if (FILTER_OPERADORA) {
    const filter = FILTER_OPERADORA.toLowerCase();
    companies = companies.filter(company => company.name.toLowerCase().includes(filter));
  }

  if (companies.length === 0) throw new Error('Nenhuma operadora encontrada.');
  log(`${companies.length} operadora(s) para processar.`);

  const summary = [];
  for (const company of companies) {
    try {
      summary.push(await processCompany(company, state));
    } catch (error) {
      log(`ERRO fatal em ${company.name}: ${error.message}`);
      state.companies[company.name] = {
        ...(state.companies[company.name] || {}),
        status: 'error',
        erro: error.message,
        updated_at: new Date().toISOString(),
      };
      saveState(state);
      summary.push({ operadora: company.name, erro: error.message });
      if (/anti-bot|429|forbidden|403/i.test(error.message)) break;
    }
  }

  const totals = summary.reduce((acc, item) => {
    acc.salvos += item.salvos || 0;
    acc.ignorados += item.ignorados || 0;
    acc.erros += item.erros || 0;
    return acc;
  }, { salvos: 0, ignorados: 0, erros: 0 });

  fs.writeFileSync(
    path.join(OUTPUT_DIR, '_resumo.js'),
    `module.exports = ${JSON.stringify({
      extraido_em: new Date().toISOString(),
      total_operadoras: summary.length,
      ...totals,
      operadoras: summary,
    }, null, 2)};\n`,
    'utf8'
  );

  log(`Concluido: ${totals.salvos} salvos, ${totals.ignorados} ignorados, ${totals.erros} erros.`);
  log('Execute "node build-catalog.js" para atualizar o HTML local.');

  // Fecha o browser ao final
  if (BROWSER) { try { await BROWSER.close(); } catch {} BROWSER = null; }
}

// Garante fechamento do browser em caso de interrupção
for (const sig of ['SIGINT', 'SIGTERM', 'exit']) {
  process.on(sig, () => { if (BROWSER) { try { BROWSER.close(); } catch {} } });
}

main().catch(error => {
  console.error(`Erro fatal: ${error.message}`);
  process.exit(1);
});
