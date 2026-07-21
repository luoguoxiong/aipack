import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z } from 'zod';
import axios from 'axios';

const WebSearchSchema = z.object({
  query: z.string().describe('Search query'),
  max_results: z.number().int().optional().default(5).describe('Maximum number of results'),
});

const WebFetchSchema = z.object({
  url: z.string().describe('URL to fetch'),
  max_length: z.number().int().optional().default(8000).describe('Maximum content length in characters'),
});

export class WebSearchTool extends BaseTool {
  name = 'web_search';
  description = 'Search the web using DuckDuckGo.';
  input_schema = WebSearchSchema;
  tags = ['web', 'search'];

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      
      const results: string[] = [];
      
      try {
        const response = await axios.get('https://api.duckduckgo.com/', {
          params: {
            q: params.query,
            format: 'json',
            no_html: 1,
            skip_disambig: 1,
          },
          timeout: 15000,
        });

        const data = response.data as { AbstractText?: string; AbstractURL?: string; RelatedTopics?: Array<{ Text?: string; FirstURL?: string }> };
        
        if (data.AbstractText) {
          results.push(`Abstract: ${data.AbstractText}`);
          if (data.AbstractURL) {
            results.push(`Source: ${data.AbstractURL}`);
          }
        }

        if (data.RelatedTopics) {
          for (const topic of data.RelatedTopics.slice(0, params.max_results)) {
            if (topic.Text) {
              results.push(topic.Text);
              if (topic.FirstURL) {
                results.push(`  ${topic.FirstURL}`);
              }
            }
          }
        }
      } catch {
        results.push(`Search for "${params.query}" - note: direct DuckDuckGo API results limited.`);
        results.push(`For better results, consider using a dedicated search API key.`);
      }

      return createToolResult(results.length > 0 ? results.join('\n\n') : 'No results found.');
    } catch (err) {
      return createToolError(`Search failed: ${(err as Error).message}`);
    }
  }
}

export class WebFetchTool extends BaseTool {
  name = 'web_fetch';
  description = 'Fetch the content of a web page and return the main text content.';
  input_schema = WebFetchSchema;
  tags = ['web', 'fetch'];

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      
      try {
        new URL(params.url);
      } catch {
        return createToolError(`Invalid URL: ${params.url}`);
      }

      const response = await axios.get(params.url, {
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; nanobot/1.0)',
        },
        responseType: 'text',
      });

      let content = response.data as string;
      const contentType = String(response.headers['content-type'] || '');
      
      if (contentType.includes('text/html')) {
        content = this.extractTextFromHtml(content);
      }

      if (content.length > params.max_length) {
        content = content.slice(0, params.max_length) + '\n... [truncated]';
      }

      return createToolResult(content || '(empty page)');
    } catch (err) {
      return createToolError(`Fetch failed: ${(err as Error).message}`);
    }
  }

  private extractTextFromHtml(html: string): string {
    let text = html;
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<[^>]*>/g, ' ');
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/\n\s*\n/g, '\n');
    text = text.replace(/[ \t]+/g, ' ');
    text = text.trim();
    return text;
  }
}

export function getWebTools(): BaseTool[] {
  return [new WebSearchTool(), new WebFetchTool()];
}
