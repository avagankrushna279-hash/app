'use strict';
// Tiny .env loader (no dependencies). Real environment variables win over the file.
const fs = require('fs'), path = require('path');
function loadEnv(dir = path.join(__dirname, '..')) {
  let text;
  try { text = fs.readFileSync(path.join(dir, '.env'), 'utf8'); } catch (e) { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
module.exports = { loadEnv };
