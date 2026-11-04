import fs from 'fs';

const content = fs.readFileSync('main.js', 'utf8');

const sIdx = content.indexOf('PHONE_MIRROR_HTML = `') + 'PHONE_MIRROR_HTML = `'.length;
const endIdx = content.indexOf('`;', sIdx);
const html = content.substring(sIdx, endIdx);

console.log('Includes id="screenshotBtn":', html.includes('id="screenshotBtn"'));
console.log('Includes <div class="toast" id="toast":', html.includes('<div class="toast" id="toast"'));
console.log('Includes id="screenshotBtn" listener:', html.includes("getElementById('screenshotBtn')"));
console.log('Includes .qa-btn.screenshot-btn:', html.includes('.qa-btn.screenshot-btn'));
