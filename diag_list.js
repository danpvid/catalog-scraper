const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const b = await chromium.launch({ headless: false });
  const ctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'pt-BR'
  });
  const p = await ctx.newPage();
  await p.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  const url = 'https://colnect.com/pt/phonecards/list/country/30-Brasil/company/16935-Embratel';
  console.log('Navegando:', url);
  await p.goto(url, { waitUntil: 'load', timeout: 45000 });

  // Aguardar Anubis
  for (let i = 0; i < 20; i++) {
    const body = await p.textContent('body').catch(() => '');
    if (body.includes('Making sure') || body.includes('Calculating')) {
      console.log('Aguardando Anubis...');
      await p.waitForTimeout(3000);
    } else break;
  }

  await p.waitForTimeout(3000);

  const info = await p.evaluate(() => {
    const allLinks = Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({ text: a.textContent.trim().substring(0, 60), href: a.href }))
      .filter(l => !l.href.includes('javascript') && l.text.length > 0);

    const phonecardLinks = allLinks.filter(l => l.href.includes('phonecard'));
    const pl400 = document.querySelector('#pl_400');

    return {
      title: document.title,
      phonecardLinksCount: phonecardLinks.length,
      phonecardLinksFirst10: phonecardLinks.slice(0, 10),
      pl400Exists: !!pl400,
      pl400InnerText: pl400 ? pl400.innerHTML.substring(0, 500) : 'não encontrado',
      allLinksCount: allLinks.length,
      bodySnippet: document.body.innerHTML.substring(10000, 11000),
    };
  });

  console.log('=== TÍTULO ===', info.title);
  console.log('=== #pl_400 existe? ===', info.pl400Exists);
  console.log('=== #pl_400 HTML ===', info.pl400InnerText);
  console.log('=== Links com "phonecard" ===', info.phonecardLinksCount);
  info.phonecardLinksFirst10.forEach(l => console.log(' ', l.href));
  console.log('=== Total links ===', info.allLinksCount);
  console.log('=== Trecho do body ===', info.bodySnippet.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));

  // Salvar HTML completo
  const html = await p.content();
  fs.writeFileSync('_diag_list.html', html);
  console.log('HTML salvo em _diag_list.html (' + html.length + ' bytes)');

  await b.close();
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
