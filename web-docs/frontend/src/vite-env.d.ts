/// <reference types="vite/client" />

/** 构建时由 vite.config.ts 的 define 注入，取自 package.json 的 version 字段 */
declare const __APP_VERSION__: string;
