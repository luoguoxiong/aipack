import { Type } from "@earendil-works/pi-ai";
import { BaseTool, createToolResult, createToolError } from './base';

const MessageToolSchema = Type.Object({
  content: Type.String({ description: '要发送的消息内容。请勿用于正常回复当前对话，仅用于主动推送。' }),
  media: Type.Optional(Type.Array(Type.String(), { description: '要附带的文件路径列表' })),
  buttons: Type.Optional(Type.Array(Type.Array(Type.String()), { description: '内联按钮，每行为一个按钮列表' })),
});

export class MessageTool extends BaseTool<typeof MessageTool.parameters> {
  name = 'message';
  label = 'Message';
  description = '主动向用户发送消息，可选择附带文件附件。请勿用于正常回复当前对话——正常回复请直接输出。';
  static parameters = MessageToolSchema;
  parameters = MessageTool.parameters;

  async execute(toolCallId: string, params: { content: string; media?: string[]; buttons?: string[][] }) {
    try {
      let content = params.content;
      content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      let mediaInfo = '';
      if (params.media && params.media.length > 0) {
        mediaInfo = ` with ${params.media.length} attachments`;
      }

      let buttonInfo = '';
      if (params.buttons && params.buttons.length > 0) {
        const totalButtons = params.buttons.reduce((sum, row) => sum + row.length, 0);
        buttonInfo = ` with ${totalButtons} button(s)`;
      }

      // In kobot, message delivery is handled by returning the content
      // which the channel will deliver to the user
      return createToolResult(
        `Message: ${content}${mediaInfo}${buttonInfo}`
      );
    } catch (err) {
      return createToolError(`Error: ${(err as Error).message}`);
    }
  }
}

export function getMessageTools(): BaseTool[] {
  return [new MessageTool()];
}
