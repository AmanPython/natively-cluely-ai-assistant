import fs from 'fs';

const content = fs.readFileSync('main.js', 'utf8');

const sIdx = content.indexOf('if (fullUrl.pathname !== "/" && fullUrl.pathname !== "/index.html") {');
console.log(content.substring(sIdx, sIdx + 1500));
