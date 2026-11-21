// Swift syntax check via the tree-sitter-swift grammar (win32-x64 prebuild).
// This catches real syntax errors in the CI-critical Swift source, which we
// cannot compile here because no Xcode/macOS is available.
const fs = require('node:fs');
const path = require('node:path');
const Parser = require('tree-sitter');
const Swift = require('tree-sitter-swift');

const files = process.argv.slice(2);
let failed = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const parser = new Parser();
  parser.setLanguage(Swift);
  const tree = parser.parse(src);
  const errors = [];

  const walk = (node) => {
    if (node.type === 'ERROR' || node.type === 'MISSING') {
      errors.push({
        type: node.type,
        line: node.startPosition.row + 1,
        col: node.startPosition.column + 1,
        text: src.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 80)).replace(/\n/g, '\\n'),
      });
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  };
  walk(tree.rootNode);

  const name = path.basename(file);
  if (errors.length) {
    failed++;
    console.log(`FAIL  ${name}: ${errors.length} syntax node error(s)`);
    for (const e of errors.slice(0, 10)) {
      console.log(`        ${e.type} at ${e.line}:${e.col}  ${JSON.stringify(e.text)}`);
    }
  } else {
    console.log(`PASS  ${name}: parsed cleanly (${tree.rootNode.namedChildCount} top-level nodes, ${src.split('\n').length} lines)`);
  }
}

process.exitCode = failed ? 1 : 0;
