/*
 * Shared by the browser tests: a headless Chrome driven over the DevTools
 * protocol (node 22 has WebSocket and fetch built in, so no npm packages).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || 'google-chrome';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/* ------------------------------------------------------------ tiny CDP client */

export class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  /** Poll `expression` until `pred(value)` holds; returns the value. */
  async until(expression, pred, what, timeoutMs = 15000) {
    const t0 = Date.now();
    let last;
    for (;;) {
      last = await this.eval(expression);
      if (pred(last)) return last;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`timed out waiting for ${what} (last ${JSON.stringify(last)})`);
      }
      await sleep(100);
    }
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    // wait for the document and its module script to finish loading
    await this.until('document.readyState', (s) => s === 'complete', 'document load');
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}


/** Start the static server and Chrome; returns { page, base, cleanup(code) }. */
export async function launch() {
  const httpPort = await freePort();
  const dbgPort = await freePort();
  const userDir = mkdtempSync(join(tmpdir(), 'dope-chrome-'));
  
  const server = spawn('python3', ['-m', 'http.server', String(httpPort), '--bind', '127.0.0.1'], {
    cwd: ROOT, stdio: 'ignore',
  });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--remote-debugging-port=' + dbgPort, '--remote-allow-origins=*',
    '--user-data-dir=' + userDir, '--window-size=640,480', '--disable-dev-shm-usage',
    'about:blank',
  ], { stdio: 'ignore' });
  
  function cleanup(code) {
    chrome.kill('SIGKILL');
    server.kill('SIGKILL');
    try { rmSync(userDir, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(code);
  }
  
  const base = `http://127.0.0.1:${httpPort}/web/`;
  
  
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
    if (!target) await sleep(100);
  }
  if (!target) { cleanup(1); throw new Error('chrome did not open a debugging port'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const page = new Page(ws);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  return { page, base, cleanup };
}
