// Print the LAN addresses the iPad can use, plus a QR-free checklist.
// Works on a normal user PC; no dependencies beyond Node's standard library.
import os from 'node:os';

const PORT = process.env.LEGADO_PORT || '1234';

const ifaces = os.networkInterfaces();
const addrs = [];
for (const [name, list] of Object.entries(ifaces)) {
  for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    if (/^169\.254\./.test(a.address)) continue; // link-local, not routable
    addrs.push({ name, address: a.address });
  }
}

if (!addrs.length) {
  console.log('  没有找到局域网地址。iPad 可能无法连接。');
  process.exit(0);
}

// Prefer a private range address: 192.168.x.x, then 10.x, then 172.16-31.x
const score = (ip) => {
  if (/^192\.168\./.test(ip)) return 0;
  if (/^10\./.test(ip)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
};
addrs.sort((a, b) => score(a.address) - score(b.address));

console.log('  在 iPad 的 Safari 里打开：');
console.log('');
for (const a of addrs) {
  console.log(`     http://${a.address}:${PORT}      (${a.name})`);
}
console.log('');
console.log('  同一台电脑上自己先试试：');
console.log(`     http://127.0.0.1:${PORT}`);

// warn if the only address is not a private LAN range
const anyPrivate = addrs.some((a) => score(a.address) < 3);
if (!anyPrivate) {
  console.log('');
  console.log('  注意：这台机器的地址不在常见家用局域网段内，');
  console.log('  iPad 需要和它接在同一个 Wi-Fi 下才连得上。');
}
