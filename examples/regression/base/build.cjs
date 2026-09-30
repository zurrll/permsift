const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync('src/input.json', 'utf8'));
const classes = input.classes.join(' ');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/result.json', JSON.stringify({ classes }));
