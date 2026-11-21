// Worker: free-running async fetch loop. The MAIN thread blocks on Atomics.wait;
// this thread stays fully async so fetch promises can resolve.
const { parentPort, workerData } = require('node:worker_threads');

const ctl = new Int32Array(workerData.sab, 0, 2);
const bytes = new Uint8Array(workerData.sab, 8);
const dec = new TextDecoder();
const enc = new TextEncoder();

let inflight = 0;
let queue = Promise.resolve();

async function handle(req) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeout || 30000);
    const r = await fetch(req.url, {
      method: req.method || 'GET',
      headers: req.headers || {},
      body: req.body || undefined,
      redirect: 'follow',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const ab = await r.arrayBuffer();
    return {
      ok: true,
      status: r.status,
      url: r.url,
      headers: Object.fromEntries(r.headers.entries()),
      body: Buffer.from(ab).toString('base64'),
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

parentPort.on('message', (req) => {
  inflight++;
  queue = queue.then(async () => {
    const res = await handle(req);
    let buf = enc.encode(JSON.stringify(res));
    if (buf.length > bytes.length) {
      buf = enc.encode(JSON.stringify({ ok: false, error: 'response too large' }));
    }
    bytes.set(buf, 0);
    Atomics.store(ctl, 1, buf.length);
    Atomics.store(ctl, 0, 2);
    Atomics.notify(ctl, 0);
    inflight--;
  });
});
