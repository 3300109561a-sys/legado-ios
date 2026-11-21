// `java` object exposed to book-source JS rules.
// Mirrors io.legado.app.help.JsExtensions / JsEncodeUtils (the parts rules use).
import crypto from 'node:crypto';
import iconv from 'iconv-lite';
import { unescapeHtml4 } from './analyzeRule.mjs';

const MD5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const SHA1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
const SHA256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function toStr(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return String(v);
}

function b64Encode(s) { return Buffer.from(toStr(s), 'utf8').toString('base64'); }
function b64Decode(s) {
  const str = toStr(s).replace(/\s+/g, '');
  try { return Buffer.from(str, 'base64').toString('utf8'); } catch { return ''; }
}

// java.ajax / java.connect / java.post — synchronous only works because we
// pre-resolve inside the rule engine's async wrapper (see analyzeUrl.mjs).
export function makeJavaBridge(analyzeRule) {
  const pending = [];

  const java = {
    // ---- encoding ----
    base64Encode: b64Encode,
    base64Decode: b64Decode,
    base64DecodeToByteArray: (s) => ({ bytes: Buffer.from(toStr(s), 'base64') }),
    md5Encode: (s) => MD5(toStr(s)),
    md5Encode16: (s) => MD5(toStr(s)).substring(8, 24),
    sha1Encode: (s) => SHA1(toStr(s)),
    sha256Encode: (s) => SHA256(toStr(s)),
    hexEncodeToString: (s) => Buffer.from(toStr(s), 'utf8').toString('hex'),
    hexDecodeToString: (s) => {
      const h = toStr(s).replace(/\s+/g, '');
      try { return Buffer.from(h, 'hex').toString('utf8'); } catch { return ''; }
    },
    strToBytes: (s) => ({ bytes: Buffer.from(toStr(s), 'utf8') }),
    bytesToStr: (b) => (b && b.bytes ? b.bytes.toString('utf8') : toStr(b)),
    androidId: () => '9774d56d682e549c',
    randomUUID: () => crypto.randomUUID(),
    encodeURI: (s) => encodeURIComponent(toStr(s)),
    toURL: (s) => encodeURI(toStr(s)),
    getCookie: () => (analyzeRule._cookieJar ? analyzeRule._cookieJar.get() : ''),
    setCookie: (c) => { if (analyzeRule._cookieJar) analyzeRule._cookieJar.set(c); },

    // ---- time ----
    timeFormat: (time, format) => {
      const d = new Date(typeof time === 'number' ? time : Number(time) || Date.now());
      const pad = (n, w = 2) => String(n).padStart(w, '0');
      const map = {
        yyyy: d.getFullYear(), YYYY: d.getFullYear(),
        MM: pad(d.getMonth() + 1), dd: pad(d.getDate()), DD: pad(d.getDate()),
        HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()),
        SSS: pad(d.getMilliseconds(), 3),
      };
      return String(format || 'yyyy/MM/dd HH:mm').replace(/yyyy|YYYY|SSS|MM|dd|DD|HH|mm|ss/g, (k) => map[k]);
    },
    timeFormatUTC: (time, format, offset) => {
      const d = new Date(typeof time === 'number' ? time : Number(time) || Date.now());
      return java.timeFormat(d.getTime() + (Number(offset) || 0) * 3600000, format);
    },
    longToast: () => {},
    toast: () => {},
    log: () => {},
    logType: () => {},

    // ---- rule engine integration ----
    get: (key) => analyzeRule.get(key),
    put: (key, value) => analyzeRule.put(key, value),
    evalJS: (js, result) => analyzeRule.evalJS(js, result),
    getString: (rule, content) => analyzeRule.getString(rule, content === undefined ? null : content),
    getStringList: (rule, content) => analyzeRule.getStringList(rule, content === undefined ? null : content) || [],
    getElements: (rule) => analyzeRule.getElements(rule),
    getElement: (rule, content) => analyzeRule.getElement(rule, content),
    setContent: (content, baseUrl) => analyzeRule.setContent(content, baseUrl),
    htmlFormat: (s) => unescapeHtml4(toStr(s)),

    // ---- browser-backed rules ----
    // Rhino/Android can drive a real WebView. On iOS there is no such thing in
    // this process, so these fail loudly instead of silently returning "".
    startBrowserAwait: (url) => {
      throw new Error(
        'java.startBrowserAwait 需要内嵌浏览器（WebView），iOS 版未实现。' +
        '该书的书源依赖浏览器渲染，请换用不依赖它的书源。');
    },
    startBrowser: (url) => analyzeRule._java.startBrowserAwait(url),
    getVerificationCode: () => '',

    // ---- network (async-backed; queue is drained by the caller) ----
    ajax: (url) => {
      const r = analyzeRule._syncFetch ? analyzeRule._syncFetch(toStr(url)) : null;
      return r == null ? '' : r;
    },
    connect: (url, header) => {
      const r = analyzeRule._syncFetch ? analyzeRule._syncFetch(toStr(url), header) : null;
      return { body: () => (r == null ? '' : r) };
    },
    post: (url, body, header) => {
      const r = analyzeRule._syncFetch ? analyzeRule._syncFetch(toStr(url), header, toStr(body)) : null;
      return { body: () => (r == null ? '' : r) };
    },

    __pending: pending,
  };

  return java;
}

export { b64Encode, b64Decode };
