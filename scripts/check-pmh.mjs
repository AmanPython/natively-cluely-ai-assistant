import fs from 'fs';

const content = fs.readFileSync('main.js', 'utf8');

const sIdx = content.indexOf('PHONE_MIRROR_HTML = `');
console.log('PHONE_MIRROR_HTML starts at:', sIdx);
const endIdx = content.indexOf('`;', sIdx);
console.log('PHONE_MIRROR_HTML ends at:', endIdx);

// Check if screenshotBtn is inside PHONE_MIRROR_HTML
const btnIdx = content.indexOf('screenshotBtn', sIdx);
console.log('screenshotBtn relative to HTML start:', btnIdx - sIdx);
