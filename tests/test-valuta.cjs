const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const source = html.split('<script>')[1].split('</script>')[0];
const elements = {}, timers = new Map(), storage = {}, downloads = [], pdfRequests=[];
const fields = Object.fromEntries(
  ['type', 'date', 'settle', 'ccy', 'isin', 'qty', 'amount', 'rate', 'fee', 'taxMode', 'withheld', 'taxFx']
    .map(key => [key, { value: '' }])
);
let timerId = 0;
let confirmation = true;
const ctx = vm.createContext({
  Intl, Date, Blob, confirm: () => confirmation,
  buildTaxPdf: async request => { pdfRequests.push(request);return '%PDF-test'; },
  localStorage: { getItem: key => storage[key], setItem: (key, value) => { storage[key] = value; } },
  document: {
    getElementById: key => elements[key] ??= {
      value: '', elements: fields, open: true, firstChild: {}, firstElementChild: {}, addEventListener() {}, showModal() {}
    },
    createElement: () => ({ click() { downloads.at(-1).filename = this.download; } })
  },
  URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
  setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
  clearTimeout: id => timers.delete(id)
});
vm.runInContext(source, ctx);
const run = code => vm.runInContext(code, ctx);
run("$('demoChoice')");
run('confirmAction=async()=>confirm()');
const calculate = run('calculate');
const tax = run('fxTaxRows');
const year = run('currentYear');
const buy = (amount = 100, rate = 8000, extra = {}) => ({ type: 'fxBuy', date: '2026-01-01', ccy: 'USD', amount, rate, fee: 0, ...extra });
const sell = (amount = 100, rate = 10000, extra = {}) => ({ type: 'fxSell', date: '2026-12-01', ccy: 'USD', amount, rate, fee: 0, ...extra });
const bondBuy = extra => ({ type: 'bondBuy', date: '2026-03-01', isin: 'TEST1', ccy: 'USD', qty: 10, amount: 80, rate: 90, fee: 0, ...extra });
const bondSell = extra => ({ type: 'bondSell', date: '2026-04-01', isin: 'TEST1', ccy: 'USD', qty: 5, amount: 50, rate: 100, fee: 0, ...extra });
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('PASS ' + name);
}
function tick(delay) {
  for (const [id, timer] of timers) {
    if (timer.delay === delay) { timers.delete(id); timer.fn(); }
  }
}

(async () => {
  for (const [label, amount, allowed, remaining] of [
    ['just below balance', 99.99, true, 0.01], ['exact balance', 100, true, 0],
    ['above balance', 100.01, false, 0], ['fractional amount', 0.25, true, 99.75]
  ]) {
    await test('FX balance boundary: ' + label, () => {
      const input = [buy(), sell(amount)];
      if (!allowed) return assert.throws(() => calculate(input));
      const { lots, sales } = calculate(input);
      closeTo(lots[0]?.qty ?? 0, remaining);
      closeTo(sales[0].cost, amount * 80);
    });
  }
  await test('FIFO across dates, with partial second lot and purchase fee', () => {
    const { sales, lots } = calculate([sell(140), buy(100, 9000, { date: '2026-02-01' }), buy(100, 8000, { fee: 100 })]);
    assert.equal(sales[0].cost, 11700);
    assert.equal(lots[0].qty, 60);
  });
  await test('Same-day FIFO uses entry order', () => {
    const { sales } = calculate([buy(50, 4000), buy(50, 5000), sell(75)]);
    assert.equal(sales[0].cost, 6500);
  });
  await test('A second currency cannot cover a shortage', () => {
    assert.throws(() => calculate([buy(1000, 12000, { ccy: 'CNY' }), sell()]));
  });
  await test('Sale date before purchase is rejected', () => {
    assert.throws(() => calculate([buy(100, 8000, { date: '2026-12-02' }), sell()]));
  });
  await test('Bond purchase requires enough currency including fee', () => {
    assert.throws(() => calculate([buy(80), bondBuy({ fee: 0.01 })]));
  });
  for (const [qty, valid] of [[9, true], [10, true], [11, false]]) {
    await test('Bond quantity boundary ' + qty, () => {
      const input = [buy(), bondBuy(), bondSell({ qty })];
      if (!valid) return assert.throws(() => calculate(input));
      const { sales, lots } = calculate(input);
      assert.equal(sales[0].cost, qty * 720);
      assert.equal(lots.find(lot => lot.key === 'TEST1')?.qty ?? 0, 10 - qty);
    });
  }
  await test('Unrelated bond issue cannot cover a sale', () => {
    assert.throws(() => calculate([buy(), bondBuy(), bondSell({ isin: 'TEST2' })]));
  });
  await test('Bond FIFO spans lots, purchase and sale fees, changed settlement date', () => {
    const { sales, lots } = calculate([
      buy(300), bondBuy({ qty: 4, amount: 40, fee: 4 }),
      bondBuy({ date: '2026-03-05', qty: 6, amount: 60, rate: 95 }),
      bondSell({ qty: 5, fee: 2, settle: '2026-04-03' })
    ]);
    assert.equal(sales[0].income, 5000);
    assert.equal(sales[0].cost, 5110);
    assert.equal(sales[0].result, -110);
    const proceeds = lots.find(lot => lot.t.type === 'bondSell');
    assert.equal(proceeds.unit, 100);
    assert.equal(proceeds.qty, 48);
    assert.equal(run('day')(proceeds.t), '2026-04-03');
  });
  for (const [taxMode, taxFx, expected] of [
    ['broker', 0, 49], ['broker', 5, 44], ['broker', 49, 0],
    ['declare', 0, 49], ['declare', 5, 44], ['declare', 49, 0]
  ]) {
    await test(`Withholding decision: ${taxMode} / ${taxFx} FX withheld`, () => {
      const { sales, lots } = calculate([buy(), bondBuy(), bondSell({ taxMode, taxFx, fee: 1, withheld: 500 })]);
      const proceeds = lots.find(lot => lot.t.type === 'bondSell');
      assert.equal(proceeds?.qty ?? 0, expected);
      assert.equal(sales[0].cost, 3700);
      assert.equal(sales[0].t.withheld, 500);
    });
  }
  for (const [soldOn, excluded] of [['2026-06-14', 0], ['2026-06-15', 10000], ['2026-06-16', 10000]]) {
    await test('Three-year anniversary: ' + soldOn, () => {
      const { sales } = calculate([buy(100, 8000, { date: '2023-06-15' }), sell(100, 10000, { date: soldOn })]);
      assert.equal(tax(sales, 'cost', 0)[0].excluded, excluded);
    });
  }
  await test('Leap-day anniversary', () => assert.equal(run('heldThreeYears("2024-02-29","2027-02-28")'), true));
  for (const [income, expected] of [[7999, 0], [8000, 0], [8001, 1]]) {
    await test('Documented-cost base boundary: ' + income, () => {
      const { sales } = calculate([buy(), sell(100, income, { fee: 50 })]);
      assert.equal(tax(sales, 'cost', 0)[0].base, expected);
    });
  }
  for (const [limit, expected] of [[0, 300000], [100000, 200000], [250000, 50000]]) {
    await test('Shared deduction across USD and CNY: ' + limit, () => {
      const { sales } = calculate([
        buy(), buy(100, 1000, { ccy: 'CNY' }), sell(100, 150000),
        sell(100, 150000, { ccy: 'CNY', date: '2026-12-02' })
      ]);
      assert.equal(tax(sales, 'fixed', limit).reduce((sum, row) => sum + row.base, 0), expected);
    });
  }
  await test('Mixed holding periods and FX bought with bond proceeds', () => {
    const { sales } = calculate([buy(100, 8000, { date: '2022-01-01' }), bondBuy(), bondSell(), sell(40, 4800)]);
    const [row] = tax(sales, 'cost', 0);
    assert.equal(row.excluded, 2400);
    assert.equal(row.deduction, 2000);
    assert.equal(row.base, 400);
    assert.equal(row.provisional, true);
  });
  await test('Split income, deduction and base reconcile to the kopeck in CSV', () => {
    const { sales } = calculate([
      buy(1, 0.01, { date: '2022-01-01' }), buy(1, 0.01), sell(2, 0.03)
    ]);
    const [row] = tax(sales, 'cost', 0);
    assert.equal(row.taxableIncome, 0.02);
    assert.equal(row.excluded, 0.01);
    assert.equal(row.deduction, 0.01);
    assert.equal(row.base, 0.01);
  });
  await test('USD example, bond included, CSV values', async () => {
    elements.demoChoice.value = 'usd'; await elements.demo.onclick();
    assert.equal(run('visibleSales.length'), 2);
    assert.equal(run('fxRows[0].base'), 3000);
    elements.export.onclick();
    const csv = await downloads.at(-1).text();
    assert.match(csv, /56400,00/);
    assert.match(csv, /12800,00/);
  });
  await test('CNY example replacement, broker excluded, net currency credited', async () => {
    elements.demoChoice.value = 'cny'; await elements.demo.onclick();
    assert.equal(run('visibleSales.length'), 1);
    assert.equal(run('fxRows[0].base'), 3450);
    elements.export.onclick();
    assert.doesNotMatch(await downloads.at(-1).text(), /DEMO-CNY|1404,00/);
  });
  await test('Mixed example, yearly method saved, prior year lots included', async () => {
    elements.demoChoice.value = 'mixed'; await elements.demo.onclick();
    assert.equal(run('fxRows[0].excluded'), 31900);
    assert.equal(run('fxRows[0].base'), 22100);
    assert.equal(run('fxRows[0].s.parts.length'), 3);
    assert.equal(run('fxRows[1].base'), 18000);
    assert.equal(run('visibleSales.length'), 3);
    assert.equal(run('visibleSales[0].result'), 7500);
    assert.equal(run('visibleSales[0].t.withheld'), 300);
    assert.equal(run('calculate(trades).sales[0].parts.length'), 2);
    assert.equal(run('calculate(trades).lots.find(lot => lot.key === "DEMO-MIX").qty'), 1);
    elements.fxMethod.value = 'fixed'; elements.fxLimit.value = '250000'; elements.fxMethod.onchange();
    assert.equal(run('fxRows[1].base'), 117100);
    assert.equal(JSON.parse(storage['currency-journal-v1-fx-settings'])[year].method, 'fixed');
    run('render(currentYear-4)');
    assert.equal(elements.fxMethod.value, 'cost');
    assert.equal(run('visibleSales.length'), 0);
    run('render(currentYear)');
  });
  await test('Sample cancellation and edited journal protection', async () => {
    confirmation = false;
    elements.demoChoice.value = 'usd'; await elements.demo.onclick();
    assert.equal(run('trades.length'), 9);
    confirmation = true;
    run('trades[0].amount++');
    await elements.demo.onclick();
    assert.equal(run('trades.length'), 9);
    assert.match(elements.journalMessage.textContent, /неизмененного учебного примера/);
  });
  await test('Thirty days of USD/CNY, weekend rate, two-second debounce', () => {
    assert.equal(run('rateDays.length'), 30);
    assert.equal(run('currencies.join(",")'), 'CNY,USD');
    assert.equal(run('cbrRates["2026-11-15"].since'), '2026-11-14');
    Object.assign(fields.type, { value: 'fxBuy' }); fields.date.value = '2026-11-20';
    fields.ccy.value = 'USD'; fields.amount.value = '3';
    elements.form.oninput({ target: fields.amount });
    fields.ccy.value = 'CNY'; fields.amount.value = '10';
    elements.form.oninput({ target: fields.ccy });
    assert.equal([...timers.values()].filter(t => t.delay === 2000).length, 1);
    assert.equal(fields.rate.value, '');
    tick(2000);
    assert.equal(fields.rate.value, 122.55);
    assert.equal(elements.hint.className, 'exchange-hint');
    assert.doesNotMatch(html, /confirmQuote/);
    fields.rate.value = 125; elements.form.oninput({ target: fields.rate });
    assert.equal(fields.rate.value, 125);
  });
  await test('Bond preview and unavailable date', () => {
    fields.type.value = 'bondSell'; elements.form.oninput({ target: fields.type });
    assert.equal(fields.rate.value, 12.2546);
    tick(2000); assert.match(elements.rubPreview.textContent, /122,55/);
    fields.settle.value = '2026-11-21'; elements.form.oninput({ target: fields.settle });
    assert.equal(fields.rate.value, '');
    assert.equal([...timers.values()].filter(t => t.delay === 2000).length, 0);
  });
  await test('A stale tab cannot overwrite changes to the journal', () => {
    const key = 'currency-journal-v1';
    const original = storage[key];
    storage[key] = '[]';
    assert.equal(run('save([], currentYear)'), false);
    assert.match(elements.error.textContent, /другой вкладке/);
    assert.equal(storage[key], '[]');
    storage[key] = original;
  });
  await test('Malformed stored JSON is left untouched', () => {
    storage['damaged-test'] = '{"broken":';
    assert.equal(run("loadStored('damaged-test', 'fallback', () => {})"), 'fallback');
    assert.throws(() => run("storeValue('damaged-test', [])"), /Сохранение недоступно/);
    assert.equal(storage['damaged-test'], '{"broken":');
  });
  await test('Declaration year filters sales, preserves older lots and leaves report selection intact', async () => {
    ctx.multiYear = [
      buy(100, 8000, { date: '2024-12-01' }),
      sell(40, 4200, { date: '2025-02-01' }),
      sell(60, 6600, { date: '2026-02-01' })
    ];
    run('trades=multiYear; render(2026)');
    elements.prepareTax.onclick();
    elements.taxYear.value = '2025'; elements.taxYear.onchange();
    assert.match(elements.taxFormLink.textContent, /2025/);
    assert.equal(elements.taxExport.disabled, false);
    await elements.taxExport.onclick();
    const file = downloads.at(-1);
    assert.match(file.filename, /2025.*\.pdf$/);
    assert.equal(file.type, 'application/pdf');
    assert.equal(pdfRequests.at(-1).fxDeduction, 320000);
    assert.equal(Number(elements.year.value), 2026);
    elements.taxYear.value = '2024'; elements.taxYear.onchange();
    assert.equal(elements.taxExport.disabled, true);
    assert.match(elements.taxSummary.textContent, /нет продаж/);
    elements.taxYear.value = '2023'; elements.taxYear.onchange();
    assert.equal(elements.taxExport.disabled, true);
    assert.match(elements.taxSummary.textContent, /Нет данных для расчета.*2023/);
    const count = downloads.length;
    await elements.taxExport.onclick();
    assert.equal(downloads.length, count);
    elements.taxYear.value = '2026'; elements.taxYear.onchange();
    assert.match(elements.taxPdfError.textContent, /бланк за 2025/);
    await elements.taxExport.onclick();
    assert.equal(pdfRequests.at(-1).year, '2026');
    assert.equal(pdfRequests.at(-1).fxDeduction, 660000);
  });
  await test('Learning dialog explains two real FIFO parts without writing trades', () => {
    const previous = run('JSON.stringify(trades)');
    elements.sampleCalculation.onclick();
    const markup = elements.calculationContent.innerHTML.replace(/\s/g,'');
    assert.match(markup, /Учебныйпример/);
    assert.match(markup, /56400/);
    assert.match(markup, /3000/);
    assert.equal(run('JSON.stringify(trades)'), previous);
  });
  await test('Sales explanations use the trade year and broker status', () => {
    run('trades=demoTrades("cny"); render(currentYear-1); explainTrade(2)');
    assert.match(elements.calculationContent.innerHTML, /Брокер полностью удержал/);
    assert.match(elements.calculationContent.innerHTML, /Комиссия продажи/);
    run('explainTrade(3)');
    assert.match(elements.calculationContent.innerHTML, /Посчитайте базу по валюте/);
  });
  await test('USD ladder crosses purchase lots, adds 100 USD and sells the entire balance', async () => {
    run('trades=[]; render(currentYear)');
    elements.demoChoice.value='ladder';
    await elements.demo.onclick();
    const {sales,lots}=run('calculate(trades)');
    assert.deepEqual(Array.from(sales,s=>Array.from(s.parts,p=>p.qty)),[[600,250],[500],[150,400,100]]);
    assert.deepEqual(Array.from(sales,s=>s.result),[6300,1000,-1050]);
    assert.equal(lots.length,0);
    assert.match(elements.journal.innerHTML,/direction-buy/);
    assert.match(elements.journal.innerHTML,/direction-sell/);
    assert.match(elements.report.innerHTML,/result-loss.*−1/);
    assert.match(elements.report.innerHTML,/result-profit.*\+6/);
    run('explainTrade(6)');
    assert.match(elements.calculationContent.innerHTML,/result-loss/);
    assert.match(elements.calculationContent.innerHTML,/100 USD/);
  });
  await test('Clear journal requires confirmation and persists an empty journal', async () => {
    assert.equal(elements.clearJournal.disabled,false);
    confirmation=false;
    await elements.clearJournal.onclick();
    assert.equal(run('trades.length'),7);
    confirmation=true;
    await elements.clearJournal.onclick();
    assert.equal(run('trades.length'),0);
    assert.equal(storage['currency-journal-v1'],'[]');
    assert.equal(elements.clearJournal.disabled,true);
    assert.equal(elements.export.disabled,true);
  });
  console.log(`${passed} cases passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
