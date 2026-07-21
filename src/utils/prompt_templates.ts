import fs from 'fs/promises';
import path from 'path';

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  template: string;
  version: string;
}

const _templateCache = new Map<string, PromptTemplate>();

export async function loadPromptTemplate(opts: {
  templateId: string;
  templateDir?: string;
}): Promise<PromptTemplate | null> {
  const cacheKey = `${opts.templateId}:${opts.templateDir || 'default'}`;
  const cached = _templateCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const dir = opts.templateDir || path.join(process.cwd(), 'templates');
  const filePath = path.join(dir, `${opts.templateId}.md`);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const template: PromptTemplate = {
      id: opts.templateId,
      name: opts.templateId,
      description: '',
      template: content,
      version: '1.0.0',
    };
    _templateCache.set(cacheKey, template);
    return template;
  } catch {
    return null;
  }
}

export async function listPromptTemplates(templateDir?: string): Promise<string[]> {
  const dir = templateDir || path.join(process.cwd(), 'templates');
  try {
    const files = await fs.readdir(dir);
    return files
      .filter(f => f.endsWith('.md'))
      .map(f => f.slice(0, -3));
  } catch {
    return [];
  }
}

export function renderPrompt(template: string, variables: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `{{${key}}}`;
    const replacement = String(value ?? '');
    result = result.replace(new RegExp(placeholder, 'g'), replacement);
  }
  return result;
}

export async function renderTemplate(opts: {
  templateId: string;
  variables: Record<string, unknown>;
  templateDir?: string;
}): Promise<string | null> {
  const template = await loadPromptTemplate({
    templateId: opts.templateId,
    templateDir: opts.templateDir,
  });
  if (!template) {
    return null;
  }
  return renderPrompt(template.template, opts.variables);
}

export function clearTemplateCache(): void {
  _templateCache.clear();
}