---
"@aipack-ai/cli": patch
---

fix(cli): 修复全局安装后 aipack 命令无任何输出的问题

- 新增独立 bin 入口 dist/bin.js，无条件调用 main()，不再依赖 argv 入口检测
- 原入口检测在全局安装（bin 符号链接名为 aipack）及 tsup 代码分割场景下失效，导致静默退出
- APP_NAME 改为取自 package.json 的 bin 字段，--help 正确显示 aipack 命令名
