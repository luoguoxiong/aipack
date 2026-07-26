import axios from 'axios';
import { Type } from "@earendil-works/pi-ai";
import { BaseTool, createToolResult, createToolError } from './base';

export class WebFetchTool extends BaseTool<typeof WebFetchTool.parameters> {
  name = 'web_fetch';
  label = 'Web Fetch';
  description = '获取网页内容';
  static parameters = Type.Object({
    url: Type.String({ description: '要获取的 URL' }),
    timeout: Type.Integer({ description: '超时时间（秒）', default: 30 }),
  });
  parameters = WebFetchTool.parameters;

  async execute(toolCallId: string, params: { url: string; timeout: number }) {
    try {
      const response = await axios.get(params.url, { timeout: params.timeout * 1000 });
      return createToolResult(response.data.toString());
    } catch (err) {
      return createToolError(`获取 URL 失败：${(err as Error).message}`);
    }
  }
}

export class WebSearchTool extends BaseTool<typeof WebSearchTool.parameters> {
  name = 'web_search';
  label = 'Web Search';
  description = '使用 DuckDuckGo 搜索网络';
  static parameters = Type.Object({
    query: Type.String({ description: '搜索关键词' }),
    max_results: Type.Integer({ description: '最大结果数量', default: 5 }),
  });
  parameters = WebSearchTool.parameters;

  async execute(toolCallId: string, params: { query: string; max_results: number }) {
    try {
      const encodedQuery = encodeURIComponent(params.query);
      const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&no_redirect=1`;
      const response = await axios.get(url, { timeout: 30000 });
      
      const results = (response.data.results || []).slice(0, params.max_results);
      if (results.length === 0) {
        return createToolResult('未找到搜索结果。');
      }
      
      const formatted = results.map((r: { title: string; snippet: string; first_url: string }) => 
        `- ${r.title}\n  ${r.snippet}\n  ${r.first_url}`
      ).join('\n\n');
      
      return createToolResult(formatted);
    } catch (err) {
      return createToolError(`搜索失败：${(err as Error).message}`);
    }
  }
}

export function getWebTools(): BaseTool[] {
  return [
    new WebFetchTool(),
    new WebSearchTool(),
  ];
}
