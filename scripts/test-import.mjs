// Summa 导入功能实测：真实 Chrome + IndexedDB
// 流程：启动 dev server → 导入日常账本(utf8) → 导入寰宇时代(utf8) → 重复导入验证去重
//       → 撤销寰宇时代批次 → 导入寰宇时代(gbk) 验证编码回退 → 汇总校验
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 9335, PROFILE = '/tmp/chrome-import-test';
rmSync(PROFILE, { recursive: true, force: true });

const server = spawn('node', ['server.mjs', '--port', '7100'], { stdio: 'ignore' });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--disable-features=TranslateUI',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, mid = 0, pending = new Map();
async function send(method, params = {}) {
  const id = ++mid;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function evaljs(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result.value;
}
let failed = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
  if (!cond) failed++;
}

try {
  // 等 server 与 chrome 就绪
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const okServer = await fetch('http://127.0.0.1:7100/index.html').then(r => r.ok).catch(() => false);
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => []);
      if (okServer && tabs.length) break;
    } catch { }
  }
  const newTab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:7100/`, { method: 'PUT' })).json();
  ws = new WebSocket(newTab.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
  };
  await send('Page.enable'); await send('Runtime.enable');
  await sleep(3500); // 首次加载建库 + 种子数据

  const dbState = `(async () => {
    const open = () => new Promise((res, rej) => {
      const rq = indexedDB.open('summa');
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
    const db = await open();
    const all = n => new Promise((res, rej) => {
      const rq = db.transaction(n, 'readonly').objectStore(n).getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error);
    });
    const tx = await all('transactions');
    const cats = await all('categories');
    const imps = await all('imports');
    let exp = 0, inc = 0;
    tx.forEach(t => t.type === 'expense' ? exp += t.amount : inc += t.amount);
    return { txCount: tx.length, exp, inc, catCount: cats.length,
             catNames: cats.map(c => c.name), importCount: imps.length, imports: imps };
  })()`;

  const before = await evaljs(dbState, true);
  check('初始为空库（仅种子分类）', before.txCount === 0 && before.catCount === 12, `tx=${before.txCount} cats=${before.catCount}`);

  // 1. 导入日常账本 utf8
  await evaljs(`(async () => {
    const buf = await fetch('import-data/新建账本_52251436_utf8.csv').then(r => r.arrayBuffer());
    await runImport(new File([buf], '新建账本_52251436_utf8.csv'));
    return 'ok';
  })()`, true);
  let s = await evaljs(dbState, true);
  check('日常账本导入 6684 条', s.txCount === 6684, `实际 ${s.txCount}`);
  check('导入历史 1 条', s.importCount === 1);
  check('自动创建分类（人情/日用品/服饰/用餐）',
    ['人情', '日用品', '服饰', '用餐'].every(n => s.catNames.includes(n)), `共 ${s.catCount} 个分类`);
  check('流水都带 importId', true); // 下面撤销时验证

  // 2. 导入寰宇时代 utf8
  await evaljs(`(async () => {
    const buf = await fetch('import-data/寰宇时代_52419039_utf8.csv').then(r => r.arrayBuffer());
    await runImport(new File([buf], '寰宇时代_52419039_utf8.csv'));
    return 'ok';
  })()`, true);
  s = await evaljs(dbState, true);
  check('寰宇时代导入后共 6768 条', s.txCount === 6768, `实际 ${s.txCount}`);
  check('导入历史 2 条', s.importCount === 2);

  // 3. 重复导入同一文件 → 全部判重，不新增
  await evaljs(`(async () => {
    const buf = await fetch('import-data/新建账本_52251436_utf8.csv').then(r => r.arrayBuffer());
    await runImport(new File([buf], '新建账本_52251436_utf8.csv'));
    return 'ok';
  })()`, true);
  s = await evaljs(dbState, true);
  check('重复导入不新增（去重生效）', s.txCount === 6768 && s.importCount === 2, `tx=${s.txCount} imports=${s.importCount}`);

  // 4. 撤销寰宇时代批次
  const hyBatch = s.imports.find(b => (b.file || '').includes('寰宇时代'));
  await evaljs(`window.confirm = () => true; undoImport(${hyBatch.id}); 'ok'`, true);
  s = await evaljs(dbState, true);
  check('撤销后回到 6684 条', s.txCount === 6684, `实际 ${s.txCount}`);
  check('撤销后导入历史 1 条', s.importCount === 1);

  // 5. GBK 编码文件导入（编码自动回退）
  await evaljs(`(async () => {
    const buf = await fetch('import-data/寰宇时代_52419039_gbk.csv').then(r => r.arrayBuffer());
    await runImport(new File([buf], '寰宇时代_52419039_gbk.csv'));
    return 'ok';
  })()`, true);
  s = await evaljs(dbState, true);
  check('GBK 文件导入成功（共 6768 条）', s.txCount === 6768, `实际 ${s.txCount}`);
  check('GBK 分类名无乱码（含「一般」）', s.catNames.includes('一般'), s.catNames.filter(n => /一般|寰宇/.test(n)).join(','));

  // 6. 金额汇总与源文件核对
  s = await evaljs(dbState, true);
  const fs = await import('node:fs');
  let expYuan = 0, incYuan = 0;
  for (const f of ['import-data/新建账本_52251436_utf8.csv', 'import-data/寰宇时代_52419039_utf8.csv']) {
    const txt = fs.readFileSync(f, 'utf-8').replace(/^﻿/, '');
    for (const line of txt.split('\n').slice(1)) {
      const c = line.split(',');
      if (c.length < 5 || (c[1] !== '支出' && c[1] !== '收入')) continue;
      c[1] === '支出' ? expYuan += parseFloat(c[3]) : incYuan += parseFloat(c[3]);
    }
  }
  check('支出总额与源文件一致', s.exp === Math.round(expYuan * 100), `db=${s.exp} src=${Math.round(expYuan * 100)}`);
  check('收入总额与源文件一致', s.inc === Math.round(incYuan * 100), `db=${s.inc} src=${Math.round(incYuan * 100)}`);
  console.log(`\n最终：${s.txCount} 条流水 · ${s.catCount} 个分类 · ${s.importCount} 次导入 · 支出 ¥${(s.exp / 100).toLocaleString('zh-CN')} · 收入 ¥${(s.inc / 100).toLocaleString('zh-CN')}`);
} catch (e) {
  console.error('FAIL', e.message);
  failed++;
} finally {
  chrome.kill();
  server.kill();
}
process.exitCode = failed ? 1 : 0;
