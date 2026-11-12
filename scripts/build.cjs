'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'public');
// Explicit allowlist: PHP, server code, tests and environment files never become static assets.
fs.rmSync(output, {recursive:true, force:true});
fs.mkdirSync(output, {recursive:true});
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
if (!html.includes('<meta name="troika-api" content="api.php">')) throw new Error('Missing source API configuration.');
html = html.replace('<meta name="troika-api" content="api.php">', '<meta name="troika-api" content="/api/game">');
html = html.replaceAll('LOCAL PLAY', 'ONLINE PLAY').replace('Local network · No accounts', 'Online table · Casual or ranked');
fs.writeFileSync(path.join(output, 'index.html'), html);
fs.cpSync(path.join(root, 'assets'), path.join(output, 'assets'), {recursive:true});
// Include the illustrated guide when present; normal local source downloads still work without it.
const guide = path.join(root, 'docs', 'jump-in-guide.html');
if (fs.existsSync(guide)) {
  fs.mkdirSync(path.join(output, 'docs'), {recursive:true});
  fs.copyFileSync(guide, path.join(output, 'docs', 'jump-in-guide.html'));
}
console.log('Built Vercel static assets in public/. Game API: /api/game');
