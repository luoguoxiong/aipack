
const fs = require('fs');
const path = require('path');
const sourceMap = require('source-map');
const sourceMapFile = path.join(__dirname, './build/static/js/main.8c20d3b2.js.map');


fs.readFile(sourceMapFile, 'utf8', async(err, sourceMapData) => {
  if (err) {
    console.error('Error reading Source Map file:', err);
    return;
  }

  const consumer = await new sourceMap.SourceMapConsumer(sourceMapData);
  const originalPosition = consumer.originalPositionFor({
    line: 2, // 替换为要查找的行号
    column: 186702, // 替换为要查找的列号
  }, true);
  const col = consumer.sourceContentFor(originalPosition.source, true);
  const lines = col.split('\n');
  const errorLine = originalPosition.line;
  const startLine = Math.max(0, errorLine - 1);
  const endLine = Math.min(lines.length, errorLine + 1);
  const nearbyCode = lines.slice(startLine, endLine).join('\n');
  console.log(nearbyCode);
});
const data = {
  'isFirst': true,
  'pageUrl': '/',
  'domain': 'localhost:8080',
  'query': '',
  'type': 'jsError',
  'message': 'Uncaught TypeError: e.a.map is not a function',
  'stack': 'TypeError: e.a.map is not a function\n    at http://localhost:8080/static/index.c7daba1d.js:41:996\n    at Array.map (<anonymous>)\n    at http://localhost:8080/static/index.c7daba1d.js:41:984',
  'colno': 996,
  'lineno': 41,
  'filename': 'http://localhost:8080/static/index.c7daba1d.js',
  'userTimeStamp': 1705034272350,
};