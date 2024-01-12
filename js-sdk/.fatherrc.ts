import { defineConfig } from 'father';

export default defineConfig({
  esm: {},
  umd: {
    entry: 'src/index', // 默认构建入口文件
  },
});
