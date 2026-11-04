import fs from 'fs';

const content = fs.readFileSync('main.js', 'utf8');

let pos = 0;
while (true) {
  const idx = content.indexOf('handleHttp(', pos);
  if (idx === -1) break;
  // find line number
  const line = content.substring(0, idx).split('\n').length;
  console.log(`Line ${line}:`, content.substring(idx - 30, idx + 100).replace(/\n/g, ' '));
  pos = idx + 10;
}
