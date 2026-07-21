import fs from 'fs';
import path from 'path';

const distDir = './dist';
let passed = 0;
let failed = 0;

function getIndexFiles(dir) {
  const results = [];
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    if (fs.statSync(fullPath).isDirectory()) {
      results.push(...getIndexFiles(fullPath));
      const indexPath = path.join(fullPath, 'index.js');
      if (fs.existsSync(indexPath)) {
        results.push(indexPath);
      }
    }
  }
  return results;
}

const indexFiles = getIndexFiles(distDir);
console.log(`发现 ${indexFiles.length} 个 index.js 文件\n`);

for (const file of indexFiles) {
  try {
    await import('./' + file);
    console.log(`✅ ${file.replace('./dist/', '')}`);
    passed++;
  } catch (err) {
    console.log(`❌ ${file.replace('./dist/', '')}: ${err.message.slice(0, 150)}`);
    failed++;
  }
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
