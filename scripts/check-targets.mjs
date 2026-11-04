import fs from 'fs';

const content = fs.readFileSync('main.js', 'utf8');

console.log('1. PHONE_MIRROR_HTML index:', content.indexOf('PHONE_MIRROR_HTML = `'));

const sBtnIdx = content.indexOf('screenshotBtn');
console.log('2. screenshotBtn index:', sBtnIdx);
if (sBtnIdx !== -1) {
  console.log('Context around screenshotBtn:\n', content.substring(sBtnIdx - 50, sBtnIdx + 150));
}

const hHttpIdx = content.indexOf('handleHttp(req, res)');
console.log('3. handleHttp index:', hHttpIdx);
if (hHttpIdx !== -1) {
  console.log('Context around handleHttp:\n', content.substring(hHttpIdx, hHttpIdx + 300));
}

const asIdx = content.indexOf('const appState = AppState.getInstance();');
console.log('4. AppState index:', asIdx);
if (asIdx !== -1) {
  console.log('Context around AppState:\n', content.substring(asIdx, asIdx + 100));
}
