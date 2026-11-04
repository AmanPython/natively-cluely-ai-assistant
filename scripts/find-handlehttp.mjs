import fs from 'fs';

const content = fs.readFileSync('main.js', 'utf8');

const sIdx = content.indexOf('handleHttp(req, res)');
console.log('handleHttp definition context:');
// Search for handleHttp(req, res) definition
let pos = 0;
while (true) {
  const next = content.indexOf('handleHttp(req, res)', pos);
  if (next === -1) break;
  console.log('Match at', next, ':\n', content.substring(next - 20, next + 300));
  pos = next + 20;
}
