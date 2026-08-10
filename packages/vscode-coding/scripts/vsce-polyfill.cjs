// Node 18 缺少全局 File（Node 20+ 才有），而 @vscode/vsce 的依赖链
// (@azure/identity → undici@7) 启动时即 require File，导致 vsce 在 Node 18 崩溃。
// 通过 NODE_OPTIONS=--require 本文件，在 vsce 加载前 polyfill globalThis.File。
// Node 20+ 已原生有 File，typeof 检测会跳过注入，无副作用。

const { Blob } = require('buffer');

if (typeof globalThis.File === 'undefined') {
  class File extends Blob {
    constructor(parts, name, options = {}) {
      super(parts, options);
      this.name = String(name);
      this.lastModified = options.lastModified || Date.now();
      this.webkitRelativePath = '';
    }
    get [Symbol.toStringTag]() {
      return 'File';
    }
  }
  globalThis.File = File;
}
