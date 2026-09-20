// 自定义 MCP server 工具夹具（纯 ESM），供 server-integration 测试验证
// 环境变量 AIPACK_MCP_TOOLS 加载外部工具模块的路径。
//
// 导出具名 `tools`（Tool[]）。

/**
 * @param {string} _id
 * @param {{ name?: string }} args
 */
async function greet(_id, args) {
  const name = String(args?.name ?? 'world');
  return { content: [{ type: 'text', text: `hello ${name}` }], details: undefined };
}

export const tools = [
  {
    name: 'greet',
    description: 'Greet someone by name',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    permissions: [],
    execute: greet,
  },
];
