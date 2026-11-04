import fs from 'fs';

const content = fs.readFileSync('main.js', 'utf8');

const sIdx = content.indexOf('PHONE_MIRROR_HTML = `') + 'PHONE_MIRROR_HTML = `'.length;
const endIdx = content.indexOf('`;', sIdx);

const html = content.substring(sIdx, endIdx);
fs.writeFileSync('scripts/extracted_phone_mirror.html', html, 'utf8');
console.log('Saved extracted_phone_mirror.html, length:', html.length);
