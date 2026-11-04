import fs from 'fs';

const content = fs.readFileSync('main.js', 'utf8');

const sIdx = content.indexOf('if (fullUrl.pathname === "/dom") {');
console.log(content.substring(sIdx, sIdx + 2000));
