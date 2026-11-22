// Summa 改名迁移实测：造旧库 suishouji-lite → 刷新 → 验证数据迁入 summa 且旧库删除
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 9334, PROFILE = '/tmp/chrome-migrate-test';
rmSync(PROFILE, { recursive: true, force: true });
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
}

try {
  let tabs;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (tabs.length) break; } catch {}
  }
  const newTab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:7100/`, { method: 'PUT' })).json();
  ws = new WebSocket(newTab.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
  };
  await send('Page.enable'); await send('Runtime.enable');
  await sleep(4000); // 首次加载：app 建 summa 库并写种子数据

  // 1. 造一个旧库（模拟老用户数据）
  await evaljs(`(async () => {
    const db = await new Promise((res, rej) => {
      const rq = indexedDB.open('suishouji-lite', 1);
      rq.onupgradeneeded = e => {
        const d = e.target.result;
        d.createObjectStore('ledgers', { keyPath: 'id', autoIncrement: true });
        d.createObjectStore('categories', { keyPath: 'id', autoIncrement: true });
        const t = d.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
        t.createIndex('byDate', 'date');
      };
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction(['ledgers','categories','transactions'], 'readwrite');
      tx.objectStore('ledgers').put({ id: 1, name: '旧账本', color: '#000', createdAt: 1, updatedAt: 1 });
      tx.objectStore('categories').put({ id: 99, name: '旧分类', type: 'expense', emoji: '🧾', color: '#123456', sort: 0, builtin: false, ledgerId: 1, createdAt: 1, updatedAt: 1 });
      tx.objectStore('transactions').put({ id: 77, amount: 12345, type: 'expense', categoryId: 99, note: '迁移测试标记', date: '2026-11-20', ledgerId: 1, createdAt: 1, updatedAt: 1 });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
    return 'legacy seeded';
  })()`, true);

  // 2. 删掉新库，模拟「老用户首次打开改名后的版本」
  await evaljs(`new Promise(res => { const rq = indexedDB.deleteDatabase('summa'); rq.onsuccess = rq.onerror = rq.onblocked = () => res('summa deleted'); })`, true);

  // 3. 刷新触发迁移
  await send('Page.reload');
  await sleep(5000);

  // 4. 验证
  const out = await evaljs(`(async () => {
    const list = (await indexedDB.databases()).map(d => d.name);
    const open = name => new Promise((res, rej) => {
      const rq = indexedDB.open(name);
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
    const db = await open('summa');
    const all = n => new Promise((res, rej) => {
      const rq = db.transaction(n, 'readonly').objectStore(n).getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error);
    });
    const tx = await all('transactions'), cats = await all('categories'), led = await all('ledgers');
    return {
      title: document.title,
      hasLegacyDb: list.includes('suishouji-lite'),
      dbs: list,
      txNotes: tx.map(t => t.note),
      catNames: cats.map(c => c.name),
      ledgerNames: led.map(l => l.name),
    };
  })()`, true);
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
}
