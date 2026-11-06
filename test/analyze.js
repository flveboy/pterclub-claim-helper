const { loadPuppeteer, findChrome } = require('./_env');

const puppeteer = loadPuppeteer();
const CHROME = findChrome();

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('file:///tmp/restored.html', { waitUntil: 'domcontentloaded' });

  const info = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr')].filter((tr) =>
      tr.querySelector('a[href*="details.php?id="]'));
    const out = rows.map((tr, i) => {
      const a = tr.querySelector('a[href*="details.php?id="]');
      const id = (a.getAttribute('href').match(/id=(\d+)/) || [])[1];
      const claim = tr.querySelector('.claim-confirm') ? '未认领' : (tr.querySelector('.remove-confirm') ? '已认领' : '?');
      return {
        i,
        id,
        claim,
        cells: tr.cells.length,
        size: tr.cells[3] ? tr.cells[3].textContent.trim() : '(no cell3)',
        table: tr.closest('table') ? tr.closest('table').getAttribute('class') || '(no class)' : 'none',
        text: tr.textContent.replace(/\s+/g, ' ').trim().slice(0, 60),
      };
    });

    // 所有 table
    const tables = [...document.querySelectorAll('table')].map((t, i) => ({
      i,
      cls: t.getAttribute('class') || '',
      rows: t.rows.length,
      hasDetails: !!t.querySelector('a[href*="details.php?id="]'),
      firstText: t.textContent.replace(/\s+/g, ' ').trim().slice(0, 70),
    }));

    const pager = [...document.querySelectorAll('a')].filter((a) =>
      /page=/.test(a.getAttribute('href') || '')).map((a) => ({
        href: a.getAttribute('href'),
        text: a.textContent.replace(/\s+/g, ' ').trim(),
        cls: a.className,
      }));

    return { rows: out, tables, pager };
  });

  console.log('== 识别行数:', info.rows.length);
  console.log('== tables ==');
  info.tables.forEach((t) => console.log(JSON.stringify(t)));
  console.log('== 前 12 行 ==');
  info.rows.slice(0, 12).forEach((r) => console.log(JSON.stringify(r)));
  console.log('== 后 12 行 ==');
  info.rows.slice(-12).forEach((r) => console.log(JSON.stringify(r)));
  console.log('== pager ==');
  info.pager.slice(0, 20).forEach((p) => console.log(JSON.stringify(p)));

  const claims = {};
  info.rows.forEach((r) => { claims[r.claim] = (claims[r.claim] || 0) + 1; });
  console.log('== claim 统计 ==', JSON.stringify(claims));
  const sizes = info.rows.filter((r) => r.cells !== 9);
  console.log('== 列数不是9的行 ==', sizes.length, JSON.stringify(sizes.slice(0, 10)));

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
