import axios from 'axios';
import { Type } from "@earendil-works/pi-ai";
import { BaseTool, createToolResult, createToolError } from './base';

export class WebFetchTool extends BaseTool<typeof WebFetchTool.parameters> {
  name = 'web_fetch';
  label = 'Web Fetch';
  description = 'Fetch the contents of a web page';
  static parameters = Type.Object({
    url: Type.String({ description: 'The URL to fetch' }),
    timeout: Type.Integer({ description: 'Timeout in seconds', default: 30 }),
  });
  parameters = WebFetchTool.parameters;

  async execute(toolCallId: string, params: { url: string; timeout: number }) {
    try {
      const response = await axios.get(params.url, { timeout: params.timeout * 1000 });
      return createToolResult(response.data.toString());
    } catch (err) {
      return createToolError(`Failed to fetch URL: ${(err as Error).message}`);
    }
  }
}

export class WebSearchTool extends BaseTool<typeof WebSearchTool.parameters> {
  name = 'web_search';
  label = 'Web Search';
  description = 'Search the web using DuckDuckGo';
  static parameters = Type.Object({
    query: Type.String({ description: 'The search query' }),
    max_results: Type.Integer({ description: 'Maximum number of results', default: 5 }),
  });
  parameters = WebSearchTool.parameters;

  async execute(toolCallId: string, params: { query: string; max_results: number }) {
    try {
      const encodedQuery = encodeURIComponent(params.query);
      const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&no_redirect=1`;
      const response = await axios.get(url, { timeout: 30000 });
      
      const results = (response.data.results || []).slice(0, params.max_results);
      if (results.length === 0) {
        return createToolResult('No search results found.');
      }
      
      const formatted = results.map((r: { title: string; snippet: string; first_url: string }) => 
        `- ${r.title}\n  ${r.snippet}\n  ${r.first_url}`
      ).join('\n\n');
      
      return createToolResult(formatted);
    } catch (err) {
      return createToolError(`Search failed: ${(err as Error).message}`);
    }
  }
}

export function getWebTools(): BaseTool[] {
  return [
    new WebFetchTool(),
    new WebSearchTool(),
  ];
}
