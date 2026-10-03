const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync('src/input.json', 'utf8'));
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/result.json', JSON.stringify({ total: input.price * input.quantity }));
