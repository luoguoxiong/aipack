import fetch from 'node-fetch';

async function getRemoteFileLine(repoUrl, filePath, lineNumber) {
  try {
    // 构建远程仓库文件的 Raw 文件 URL
    const rawFileUrl = 'https://gitlab.codemao.cn/frontend/rocket/lbk-operational-system/-/raw/master/.arcconfig'; // 替换为您的仓库分支和文件路径

    console.log(rawFileUrl);
    // 发送 HTTP GET 请求获取文件内容
    const response = await fetch(rawFileUrl);
    if (!response.ok) {
      throw new Error(`无法获取文件：HTTP 错误 ${response.status}`);
    }

    // 将响应内容解析为文本
    const fileContent = await response.text();
    console.log('fileContent', fileContent);
    // 按行拆分文件内容并获取指定行的代码
    const lines = fileContent.split('\n');
    const line = lines[lineNumber - 1]; // 注意行号从1开始

    if (line === undefined) {
      throw new Error('指定行不存在');
    }

    return line;
  } catch (error) {
    console.error('获取文件行内容时出错：', error);
    return null;
  }
}

// 使用示例
const repositoryUrl = 'https://github.com/luoguoxiong/hulljs'; // 替换为实际的仓库 URL
const filePath = '/.eslintrc.js'; // 替换为实际的文件路径
const lineNumber = 2; // 替换为您要查找的行号

getRemoteFileLine(repositoryUrl, filePath, lineNumber)
  .then((line) => {
    if (line !== null) {
      console.log(`行号 ${lineNumber} 的代码：\n${line}`);
    } else {
      console.log('无法获取代码行。');
    }
  });
