// Synchronous HTTP bridge.
// Legado's Rhino engine evaluates book-source JS synchronously, so `java.ajax()`
// must block. The main thread blocks on Atomics.wait while a worker thread - fully
// async, never blocked - performs the fetch and publishes the result.
// No pipes and no child_process: safe under the Windows sandbox.
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const STATE = 0;
const LEN = 1;
const HEADER_INTS = 2;
const CAPACITY = 64 * 1024 * 1024;

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'syncfetch-worker.cjs');

export class SyncFetcher {
  constructor() {
    this.sab = new SharedArrayBuffer(HEADER_INTS * 4 + CAPACITY);
    this.ctl = new Int32Array(this.sab, 0, HEADER_INTS);
    this.bytes = new Uint8Array(this.sab, HEADER_INTS * 4);
    this.enc = new TextEncoder();
    this.dec = new TextDecoder();
    this.worker = new Worker(WORKER_PATH, { workerData: { sab: this.sab } });
    this.worker.unref();
    this.worker.on('error', (e) => { this.fatal = String(e && e.message || e); });
    this.broken = false;
  }

  // Blocking request. Returns { status, url, headers, bodyBuffer }.
  request(url, { method = 'GET', headers = {}, body = null, timeout = 30000 } = {}) {
    if (this.broken) throw new Error(this.fatal || 'sync fetcher unavailable');
    const payload = { url, method, headers, body, timeout };
    Atomics.store(this.ctl, STATE, 1);          // arm state before posting
    Atomics.store(this.ctl, LEN, 0);
    this.worker.postMessage(payload);

    const deadline = Date.now() + timeout + 10000;
    for (;;) {
      const st = Atomics.load(this.ctl, STATE);
      if (st === 2) break;
      if (this.fatal) { this.broken = true; throw new Error(this.fatal); }
      Atomics.wait(this.ctl, STATE, st, 250);
      if (Date.now() > deadline) throw new Error('sync fetch timeout: ' + url);
    }
    const len = Atomics.load(this.ctl, LEN);
    const res = JSON.parse(this.dec.decode(this.bytes.subarray(0, len)));
    Atomics.store(this.ctl, STATE, 0);
    if (!res.ok) throw new Error(res.error || 'fetch failed');
    res.bodyBuffer = Buffer.from(res.body, 'base64');
    return res;
  }

  close() { try { this.worker.terminate(); } catch { /* ignore */ } }
}
