/**
 * Diagnóstico: intercepta todas as requisições de rede na página de listagem
 * para encontrar endpoints JSON internos do Colnect.
 */
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const b = await chromium.launch({ headless: false });
  const ctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'pt-BR',
  });
  const p = await ctx.newPage();
  await p.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  const requests = [];
  const responses = [];

  // Capturar todas as requisições
  p.on('request', req => {
    requests.push({ method: req.method(), url: req.url(), type: req.resourceType() });
  });

  // Capturar respostas JSON
  p.on('response', async res => {
    const ct = res.headers()['content-type'] || '';
    if (ct.includes('json') || ct.includes('javascript')) {
      const url = res.url();
      try {
        const body = await res.text().catch(() => '');
        if (body.startsWith('[') || body.startsWith('{')) {
          responses.push({ url, status: res.status(), body: body.substring(0, 500) });
        }
      } catch {}
    }
  });

  // 1. Página de listagem
  const listUrl = 'https://colnect.com/pt/phonecards/list/country/30-Brasil/company/16935-Embratel';
  console.log('\n[1] Carregando página de listagem...');
  await p.goto(listUrl, { waitUntil: 'load', timeout: 45000 });

  for (let i = 0; i < 15; i++) {
    const body = await p.textContent('body').catch(() => '');
    if (body.includes('Making sure') || body.includes('Calculating')) {
      console.log('  Aguardando Anubis...');
      await p.waitForTimeout(3000);
    } else break;
  }

  await p.waitForTimeout(4000);

  console.log('\n=== REQUISIÇÕES FEITAS ===');
  requests.filter(r => !r.url.includes('.css') && !r.url.includes('.ico') && !r.url.includes('favicon'))
    .forEach(r => console.log(`  [${r.type}] ${r.method} ${r.url}`));

  console.log('\n=== RESPOSTAS JSON ENCONTRADAS ===');
  responses.forEach(r => {
    console.log(`  ${r.status} ${r.url}`);
    console.log(`    Amostra: ${r.body.substring(0, 200)}`);
  });

  // 2. Agora página de detalhe de um cartão
  console.log('\n[2] Carregando página de detalhe de cartão...');
  const requests2 = [];
  const responses2 = [];
  p.on('request', req => requests2.push({ method: req.method(), url: req.url(), type: req.resourceType() }));
  p.on('response', async res => {
    const ct = res.headers()['content-type'] || '';
    if (ct.includes('json') || ct.includes('javascript')) {
      try {
        const body = await res.text().catch(() => '');
        if (body.startsWith('[') || body.startsWith('{')) {
          responses2.push({ url: res.url(), status: res.status(), body: body.substring(0, 500) });
        }
      } catch {}
    }
  });

  await p.goto('https://colnect.com/pt/phonecards/phonecard/25572', { waitUntil: 'load', timeout: 45000 });
  await p.waitForTimeout(4000);

  console.log('\n=== REQUISIÇÕES DETALHE ===');
  requests2.filter(r => !r.url.includes('.css') && !r.url.includes('.ico') && r.type !== 'image')
    .forEach(r => console.log(`  [${r.type}] ${r.method} ${r.url}`));

  console.log('\n=== RESPOSTAS JSON DETALHE ===');
  responses2.forEach(r => {
    console.log(`  ${r.status} ${r.url}`);
    console.log(`    Amostra: ${r.body.substring(0, 300)}`);
  });

  // Verificar campos da página de detalhe
  const detailData = await p.evaluate(() => {
    const result = {};
    result.title = document.title;
    // Buscar scripts com dados JSON embutidos
    const scripts = Array.from(document.querySelectorAll('script:not([src])'));
    result.inlineScripts = scripts
      .map(s => s.textContent.trim())
      .filter(t => t.includes('{') && (t.includes('item') || t.includes('phonecard') || t.includes('data')))
      .map(t => t.substring(0, 300));

    // Tentar encontrar dados estruturados JSON-LD
    const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map(s => s.textContent);
    result.jsonLd = jsonLd;

    // Verificar se existe meta tags com dados
    const metas = Array.from(document.querySelectorAll('meta[content]'))
      .filter(m => m.getAttribute('name') || m.getAttribute('property'))
      .map(m => ({ name: m.getAttribute('name') || m.getAttribute('property'), content: m.getAttribute('content') }));
    result.metas = metas;

    return result;
  });

  console.log('\n=== DADOS ESTRUTURADOS NA PÁGINA DE DETALHE ===');
  console.log('JSON-LD:', detailData.jsonLd);
  console.log('Scripts inline com dados:', detailData.inlineScripts);
  console.log('Meta tags:', JSON.stringify(detailData.metas, null, 2));

  fs.writeFileSync('_diag_network.json', JSON.stringify({ requests, responses, requests2, responses2, detailData }, null, 2));
  console.log('\nSalvo em _diag_network.json');

  await b.close();
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
