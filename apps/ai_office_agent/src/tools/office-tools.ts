/**
 * apps/ai_office_agent/src/tools/office-tools.ts
 *
 * 通用 Office 工具集(全部通过 OfficeCLI 实现,不写死任何文档模板):
 *   - office_read  查:officecli view 读取任意文档内容
 *     (xlsx → 单元格文本;docx/pptx → 结构大纲,含每页/每段内容)
 *   - office_help  查:officecli help 按需查询能力参考(元素/属性语法,随版本自动更新),
 *     agent 不确定命令语法时先查再写,新功能无需改提示词
 *   - office_exec  增/改/删:LLM 识别用户意图 → 生成 officecli batch 命令数组
 *     (create 空文档 → add/set/remove 元素 → close 刷盘),覆盖创建/修改/删除全场景
 *
 * 读取与修改前的「读原文」都走 office_read;任何增删改都走 office_exec,
 * 由 LLM 按用户意图动态生成命令,代码不预置任何版式/模板。
 *
 * 安全约定:
 *   - 路径一律相对工作区,由 resolveInWorkspace 校验(防 .. 逃逸)
 *   - office_exec 覆盖写前自动备份 .bak
 *   - 同一文件的并发写经 withFileLock 串行化(读-改-写是整文件操作)
 *   - commands 中携带文件路径的 props(src/image/out)做工作区越界校验
 */
import { promises as fs } from 'node:fs';
import type { Tool } from '@aipack-ai/agent';
import type { Workspace } from './workspace.js';
import { resolveInWorkspace, assertExists, backupFile, ensureDirForFile } from './workspace.js';
import { withFileLock } from '../utils/mutex.js';
import type { OfficeBatchCommand } from './officecli.js';
import { officeReadDocument, officeExecuteScript, officeHelp, officecliAvailable } from './officecli.js';

const MAX_READ_CHARS = 40000; // office_read 输出上限,防止撑爆上下文
const MAX_HELP_CHARS = 8000; // office_help 输出上限
const MAX_SUMMARY_CHARS = 4000; // office_exec 返回摘要上限

/** props 中可能携带文件路径的键,写入前须做工作区越界校验 */
const PATH_PROPS = ['src', 'image', 'out'];

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '\n\n[…内容过长已截断…]';
}

// ─── 查:office_read ───────────────────────────────────────────────

export function createOfficeReadTool(ws: Workspace): Tool {
  return {
    name: 'office_read',
    description:
      '读取任意 Office 文档内容(.xlsx → 单元格文本;.docx/.pptx → 结构大纲:标题/段落/表格/每页要点)。' +
      '当用户要求查看/分析/修改文档时,先调用本工具拿到原文。可指定 mode 与 maxLines 控制输出。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Office 文件路径(相对工作区,如 "report.docx")' },
        mode: { type: 'string', enum: ['outline', 'text'], description: '可选,读取模式:outline 大纲 / text 纯文本;缺省按扩展名自动判断(xlsx→text,docx/pptx→outline)' },
        maxLines: { type: 'number', description: '可选,输出行数上限(默认 60),大文档可调小' },
      },
      required: ['filePath'],
    },
    permissions: ['fs:read'],
    async execute(_toolCallId, args) {
      const { filePath, mode, maxLines } = (args ?? {}) as {
        filePath?: string;
        mode?: 'outline' | 'text';
        maxLines?: number;
      };
      try {
        if (!filePath) throw new Error('缺少 filePath 参数');
        if (!(await officecliAvailable())) {
          throw new Error('未检测到 officecli,请先安装:npm i -g @officecli/officecli 或 brew install officecli');
        }
        const abs = resolveInWorkspace(ws.root, filePath);
        await assertExists(abs);

        const outline = await officeReadDocument(abs, { mode, maxLines });
        return {
          content: [{ type: 'text', text: `文件 ${filePath} 内容:\n${truncate(outline, MAX_READ_CHARS)}` }],
          details: { filePath, truncated: outline.length > MAX_READ_CHARS },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `[office_read] ${(err as Error).message}` }],
          details: { error: (err as Error).message },
        };
      }
    },
  };
}

// ─── 查:office_help(能力参考,按需查询语法)──────────────────────

export function createOfficeHelpTool(): Tool {
  return {
    name: 'office_help',
    description:
      '查询 OfficeCLI 能力参考(officecli help,随版本自动更新):返回指定格式(xlsx/docx/pptx)的全部元素清单,或某元素/操作的完整语法——支持路径、可用属性名、属性类型、示例。' +
      '生成 office_exec 的 commands 前,若不确定元素名、路径格式或属性名(如 autofilter、sort、cell 样式、chart),先调用本工具查询准确语法,不要凭记忆编造。',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['xlsx', 'docx', 'pptx'], description: '文档格式(必填)' },
        topic: {
          type: 'string',
          description:
            '可选:元素名(如 cell/chart/table/autofilter/sort/picture)或操作(add/set/remove);不填返回该格式全部元素清单',
        },
      },
      required: ['format'],
    },
    permissions: ['fs:read'],
    async execute(_toolCallId, args) {
      const { format, topic } = (args ?? {}) as { format?: 'xlsx' | 'docx' | 'pptx'; topic?: string };
      try {
        if (!format || !['xlsx', 'docx', 'pptx'].includes(format)) {
          throw new Error('format 必须是 xlsx / docx / pptx');
        }
        if (!(await officecliAvailable())) {
          throw new Error('未检测到 officecli,请先安装:npm i -g @officecli/officecli 或 brew install officecli');
        }
        const out = await officeHelp(format, topic);
        return {
          content: [{ type: 'text', text: truncate(out, MAX_HELP_CHARS) }],
          details: { format, topic },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `[office_help] ${(err as Error).message}` }],
          details: { error: (err as Error).message },
        };
      }
    },
  };
}

// ─── 增/改/删:office_exec ─────────────────────────────────────────

const OFFICE_EXEC_DESCRIPTION = `执行 OfficeCLI batch 脚本,实现 Office 文档的创建/修改/删除(单次 open→save 周期)。
所有操作都通过 commands 命令数组表达,由你根据用户意图生成,不依赖任何预置模板。

commands 命令结构:
- add:新增元素,{ command:'add', parent:父路径, type:元素类型, props:{...} }
- set:修改已有元素,{ command:'set', path:元素路径, props:{...} }
- remove:删除元素,{ command:'remove', path:元素路径 }
约定:path 形如 '/Sheet1/A1'、'/Sheet1/A1:K1'(范围)、'/slide[2]'、'/body';颜色用十六进制如 'FF0000' 红、'00B050' 绿;pptx 坐标用英寸如 x='2in'。

常用元素:sheet/cell/row/chart/table/picture/paragraph/markdown/style/shape/autofilter/sort 等。

用法要点:
1. 不确定某元素的路径、可用属性名或属性值时,先调用 office_help 查询准确语法(如 office_help format='xlsx' topic='autofilter'),再生成 commands。不要凭记忆编造属性名——查到的才是权威。
2. 新建文件:create=true(或文件不存在时自动创建空文档);pptx 先 add slide 再向 slide 里 add 元素。
3. 修改现有文件:先 office_read 读原文确定路径(set/remove 用 path,add 用 parent),再 set/remove/add。
4. Word 标题若未定义样式,先 add style(Heading1-6, basedOn 'Normal', bold, 深色)再 add paragraph style='Heading1'。
5. 覆盖写前工具自动备份 .bak。
示例-给 PPT 第 2 页加表格:commands=[{"command":"add","parent":"/slide[2]","type":"table","props":{"data":"指标,数值;营收,1200万","x":"1in","y":"2in","width":"6in","height":"2in"}}]
示例-写 Excel 单元格:commands=[{"command":"set","path":"/Sheet1/A1","props":{"value":"姓名"}}]

重要:Excel 单元格(cell / set cell)完整支持样式设置——背景填充色(fill)、字体颜色(font.color)、加粗(font.bold)、字号(font.size)、对齐(halign/valign)、边框(border.*)、数字格式(numFmt);还支持表头筛选/排序下拉(autofilter)、按列排序(sort)、冻结行(freeze)等。用户要求修改颜色/背景/加粗/排序/筛选等格式与功能时,直接生成对应命令,切勿声称工具不支持。`;

export function createOfficeExecTool(ws: Workspace): Tool {
  return {
    name: 'office_exec',
    description: OFFICE_EXEC_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: '目标文件(相对工作区,如 "定制.pptx")。已存在则在其上追加/修改;不存在会自动创建空文档',
        },
        create: {
          type: 'boolean',
          description: '强制重新创建空文档(会丢弃原内容,覆盖前自动备份 .bak,谨慎使用)',
        },
        commands: {
          type: 'array',
          description: 'officecli batch 命令数组(按顺序在单次 open→save 周期内执行,任一失败整体回滚)',
          items: {
            type: 'object',
            properties: {
              command: { type: 'string', enum: ['add', 'set', 'remove'], description: '操作:add 新增 / set 修改 / remove 删除' },
              path: { type: 'string', description: 'DOM 路径:set/remove 必填(add 可用作 parent 兜底)。如 /Sheet1/A1、/Sheet1/A1:K1、/slide[1]、/body' },
              parent: { type: 'string', description: '父路径:add 必填。如 /body、/slide[1]、/Sheet1' },
              type: { type: 'string', description: '元素类型:add 必填。如 shape/chart/table/picture/paragraph/sheet/cell/row/style' },
              props: { type: 'object', description: '元素属性键值对(见工具描述;set cell 支持 font.color/fill/font.bold/halign 等样式)' },
            },
            required: ['command'],
          },
        },
      },
      required: ['filePath', 'commands'],
    },
    permissions: ['fs:write'],
    async execute(_toolCallId, args) {
      const { filePath, create, commands } = (args ?? {}) as {
        filePath?: string;
        create?: boolean;
        commands?: OfficeBatchCommand[];
      };
      try {
        if (!filePath) throw new Error('缺少 filePath 参数');
        if (!Array.isArray(commands) || !commands.length) throw new Error('缺少 commands 参数');
        if (!(await officecliAvailable())) {
          throw new Error('未检测到 officecli,请先安装:npm i -g @officecli/officecli 或 brew install officecli');
        }
        const abs = resolveInWorkspace(ws.root, filePath);

        // 校验 props 中的文件路径键:拒绝工作区外路径
        for (const c of commands) {
          for (const key of PATH_PROPS) {
            const v = (c.props ?? {})[key];
            if (typeof v === 'string' && v.trim()) {
              resolveInWorkspace(ws.root, v);
            }
          }
        }

        // 读-改-写整文件操作:加 per-file 锁 + 覆盖前备份
        return await withFileLock(abs, async () => {
          await ensureDirForFile(abs);
          let willCreate = !!create;
          try {
            await fs.access(abs);
          } catch {
            willCreate = true;
          }
          if (willCreate) {
            // 重建空文档:覆盖前备份,再删除(officecli create 不覆盖已存在文件)
            await backupFile(abs);
            await fs.rm(abs, { force: true });
          }

          const summary = await officeExecuteScript(abs, commands, { create: willCreate });
          return {
            content: [
              {
                type: 'text',
                text: `officecli 脚本已执行:${filePath}${willCreate ? '(新建)' : ''}\n${truncate(summary, MAX_SUMMARY_CHARS)}`,
              },
            ],
            details: { filePath, action: 'exec', commands: commands.length, create: willCreate },
          };
        });
      } catch (err) {
        return {
          content: [{ type: 'text', text: `[office_exec] ${(err as Error).message}` }],
          details: { error: (err as Error).message },
        };
      }
    },
  };
}

/** 汇总导出 Office 通用工具集 */
export function createOfficeTools(ws: Workspace): Tool[] {
  return [createOfficeReadTool(ws), createOfficeHelpTool(), createOfficeExecTool(ws)];
}
