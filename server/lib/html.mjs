// jsoup-compatible subset over parse5 (htmlparser2 tree adapter) + css-select.
// Mirrors the semantics AnalyzeByJSoup / AnalyzeByJSoup.SourceRule rely on.
import { parse, parseFragment } from 'parse5';
import { adapter } from 'parse5-htmlparser2-tree-adapter';
import { selectAll } from 'css-select';
import serializeDom from 'dom-serializer';

function isTag(n) { return !!n && (n.type === 'tag' || n.type === 'script' || n.type === 'style'); }
function isTextNode(n) { return !!n && n.type === 'text'; }

const BLOCK = new Set([
  'p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'section', 'article', 'dd', 'dt', 'pre', 'table', 'ul', 'ol',
]);

// jsoup Element.text() collapses whitespace and separates blocks with spaces.
export function normaliseText(s) {
  if (!s) return '';
  return s.replace(/\u00a0/g, ' ').replace(/[ \t\r\n\f\v]+/g, ' ').trim();
}

function walkText(node, out) {
  if (!node) return out;
  if (node.type === 'text') { out.push(node.data); return out; }
  if (node.type === 'comment' || node.type === 'directive') return out;
  const children = node.children || [];
  for (const c of children) {
    if (c.type === 'text') {
      out.push(c.data);
    } else if (c.type === 'tag' || c.type === 'script' || c.type === 'style') {
      const name = (c.name || '').toLowerCase();
      if (name === 'br') { out.push('\n'); continue; }
      if (name === 'script' || name === 'style') continue;
      const block = BLOCK.has(name);
      if (block) out.push('\n');
      walkText(c, out);
      if (block) out.push('\n');
    } else {
      walkText(c, out);
    }
  }
  return out;
}

export class JNode {
  constructor(node, baseUrl = '') {
    this.node = node;
    this.baseUrl = baseUrl;
  }

  get name() {
    const n = this.node;
    if (!n) return '';
    if (n.type === 'text') return '#text';
    if (n.type === 'root') return '#document';
    if (n.type === 'comment') return '#comment';
    return (n.name || '').toLowerCase();
  }

  get type() { return this.node ? this.node.type : ''; }

  text() {
    if (!this.node) return '';
    if (this.node.type === 'text') return normaliseText(this.node.data);
    return normaliseText(walkText(this.node, []).join(' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n+/g, ' '));
  }

  ownText() {
    if (!this.node || !this.node.children) return '';
    const parts = [];
    for (const c of this.node.children) {
      if (c.type === 'text') parts.push(c.data);
      else if (c.type === 'tag' && (c.name || '').toLowerCase() === 'br') parts.push('\n');
    }
    return normaliseText(parts.join(' '));
  }

  textNodes() {
    if (!this.node || !this.node.children) return '';
    return this.node.children
      .filter((c) => c.type === 'text')
      .map((c) => normaliseText(c.data))
      .filter(Boolean)
      .join('\n');
  }

  data() {
    if (!this.node) return '';
    const t = this.node.type;
    if (t === 'script' || t === 'style' || t === 'comment') {
      if (t === 'comment') return this.node.data || '';
      return this.html();
    }
    return this.text();
  }

  html() {
    if (!this.node) return '';
    if (this.node.type === 'text') return this.node.data || '';
    // domutils/getInnerHTML escapes non-ASCII by default; jsoup does not.
    try { return serializeDom(this.node, { encodeEntities: 'utf8', innerHTML: true }); } catch { return ''; }
  }

  outerHtml() {
    if (!this.node) return '';
    if (this.node.type === 'text') return this.node.data || '';
    try { return serializeDom(this.node, { encodeEntities: 'utf8' }); } catch { return ''; }
  }

  attr(attrName) {
    if (!this.node) return '';
    const a = this.node.attribs || {};
    const key = String(attrName);
    if (Object.prototype.hasOwnProperty.call(a, key)) return a[key];
    const lower = key.toLowerCase();
    for (const k of Object.keys(a)) if (k.toLowerCase() === lower) return a[k];
    if (lower.startsWith('abs:')) {
      const raw = this.attr(key.slice(4));
      return raw ? this.absUrl(key.slice(4)) : '';
    }
    return '';
  }

  hasAttr(name) { return this.attr(name) !== ''; }

  absUrl(name) {
    const v = this.attr(name);
    if (!v) return '';
    return resolveUrl(v, this.baseUrl);
  }

  select(css) {
    if (!this.node) return [];
    let found;
    try {
      const root = this.node.type === 'root' ? this.node : this.node;
      found = selectAll(css, root);
    } catch {
      return [];
    }
    return found.map((n) => new JNode(n, this.baseUrl));
  }

  selectFirst(css) {
    const l = this.select(css);
    return l.length ? l[0] : null;
  }

  childNodes() {
    if (!this.node || !this.node.children) return [];
    return this.node.children.map((c) => new JNode(c, this.baseUrl));
  }

  children() {
    if (!this.node || !this.node.children) return [];
    return this.node.children.filter(isTag).map((c) => new JNode(c, this.baseUrl));
  }

  parent() {
    const p = this.node && this.node.parent;
    return p ? new JNode(p, this.baseUrl) : null;
  }

  nextSibling() {
    const p = this.node && this.node.parent;
    if (!p || !p.children) return null;
    const i = p.children.indexOf(this.node);
    const n = p.children[i + 1];
    return n ? new JNode(n, this.baseUrl) : null;
  }

  previousSibling() {
    const p = this.node && this.node.parent;
    if (!p || !p.children) return null;
    const i = p.children.indexOf(this.node);
    const n = p.children[i - 1];
    return n ? new JNode(n, this.baseUrl) : null;
  }

  toString() { return this.outerHtml(); }
}

export function resolveUrl(u, base) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return s;
  try { return new URL(s, base || 'http://localhost/').toString(); } catch { return s; }
}

export function parseDocument(content, baseUrl = '') {
  const s0 = typeof content === 'string' ? content : String(content ?? '');
  const s = s0.trimStart();
  // jsoup xmlParser path for XML documents
  const isXml = s.startsWith('<?xml') || s.startsWith('<!DOCTYPE') && /<[^>]+:\w+/.test(s);
  const opts = { treeAdapter: adapter, scriptingEnabled: false };
  let doc;
  if (s0.includes('<') && !/^\s*<?/.test(s0)) {
    // fragment-ish: wrap so selectors behave like a document
    doc = parse(s0, opts);
  } else {
    doc = parse(s0, opts);
  }
  return new JNode(doc, baseUrl);
}

export { isTag, isTextNode };

