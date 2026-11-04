import fs from 'fs';

const content = fs.readFileSync('main.js', 'utf8');

const sIdx = content.indexOf('handleHttp(req, res) {');
console.log(content.substring(sIdx, sIdx + 1500));
