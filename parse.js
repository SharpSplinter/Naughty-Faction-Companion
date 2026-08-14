const fs = require('fs');

const jsFile = './app.js';       // Change to your JS file path
const reqFile = './requirements.txt';

if (!fs.existsSync(jsFile)) {
    console.error('JS file not found.');
    process.exit(1);
}

const content = fs.readFileSync(jsFile, 'utf8');
const packages = new Set();

// Match ES6 imports: import ... from 'package-name' or "package-name"
const importRegex = /import\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]/g;
// Match CommonJS requires: require('package-name') or require("package-name")
const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

let match;
while ((match = importRegex.exec(content)) !== null) {
    if (!match[1].startsWith('.') && !match[1].startsWith('/')) {
        packages.add(match[1].split('/')[0]);
    }
}

while ((match = requireRegex.exec(content)) !== null) {
    if (!match[1].startsWith('.') && !match[1].startsWith('/')) {
        packages.add(match[1].split('/')[0]);
    }
}

fs.writeFileSync(reqFile, Array.from(packages).join('\n') + '\n', 'utf8');
console.log('Successfully updated requirements.txt');
