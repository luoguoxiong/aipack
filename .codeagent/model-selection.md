# 模型选择功能(ai_travel_agent)

## 任务
为 `apps/ai_travel_agent` 添加前端模型选择:用户可在 UI 选择具体模型,Researcher/Planner 共用所选模型。

## 关键决策
- 选具体模型(从 agentpack 内置 27 个模型,按 provider 分组下拉)
- Researcher 与 Planner 共用所选模型
- 未配置 API Key 的模型禁用并提示所需环境变量
- Runtime 按 `(provider, modelId)` 缓存复用,模型标识编入 sessionKey 隔离会话

## 改动文件
- `src/config.ts`:`ModelOption` 类型 + `AppConfig.models` 目录 + `buildModel` + `resolveModelChoice` 校验
- `src/runtime.ts`:`RuntimeRegistry`(按模型缓存)+ `PlanInput.modelKey` 编入 sessionKey
- `src/server.ts`:用 registry 替代预构建单例 + `/api/config` 返回 `models`/`defaultModel` + `handlePlan` 校验模型选择
- `public/index.html`:新增模型 `<select>` 控件
- `public/app.js`:渲染下拉(optgroup 分组/禁用未配置并提示 envVar)+ 提交 `model` 字段 + 状态栏联动
- `public/style.css`:`.field select` 样式 + `color-scheme: dark`

## 验证
- `pnpm --filter ai-travel-agent typecheck` 零错误
- `/api/config` 返回 27 模型(3 可用,deepseek)+ `defaultModel`
- 浏览器验证:下拉渲染 27 选项按 provider 分组、禁用项带 envVar 提示、默认选中 `deepseek-v4-flash`、切换到 `deepseek-chat` 后状态栏联动为 `模型 DeepSeek Chat · LLM ✅ 已就绪 · 搜索:…`

## 日期
2026-08-06
