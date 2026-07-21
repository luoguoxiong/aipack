import { createOutboundMessage } from '../bus/events.js';
import type { CommandRouter, CommandContext } from './router.js';

export function registerBuiltinCommands(router: CommandRouter): void {
  router.exact('/help', cmdHelp);
  router.exact('/start', cmdStart);
  router.exact('/stop', cmdStop);
  router.exact('/model', cmdModel);
  router.exact('/models', cmdModels);
  router.exact('/skill', cmdSkill);
  router.exact('/skills', cmdSkills);
  router.exact('/version', cmdVersion);
}

async function cmdHelp(ctx: CommandContext) {
  const helpText = [
    '*Built-in commands:*',
    '  • /help — Show command list',
    '  • /model <name> — Switch chat model',
    '  • /models — List available models',
    '  • /skill <name> — Load/remove a skill',
    '  • /skills — List available skills',
    '  • /stop — Cancel the current run',
    '  • /version — Show version',
  ].join('\n');

  return createOutboundMessage({
    channel: ctx.msg.channel,
    chat_id: ctx.msg.chat_id,
    text: helpText,
    metadata: { stop_turn: true },
  });
}

async function cmdStart(ctx: CommandContext) {
  return createOutboundMessage({
    channel: ctx.msg.channel,
    chat_id: ctx.msg.chat_id,
    text: '👋 Hello! How can I help you today?',
  });
}

async function cmdStop(ctx: CommandContext) {
  return createOutboundMessage({
    channel: ctx.msg.channel,
    chat_id: ctx.msg.chat_id,
    text: 'Stopping…',
    metadata: { stop_turn: true, interrupt: true },
  });
}

async function cmdModel(ctx: CommandContext) {
  const arg = ctx.args.trim();
  if (!arg) {
    return createOutboundMessage({
      channel: ctx.msg.channel,
      chat_id: ctx.msg.chat_id,
      text: 'Use `/model <name>` to switch the chat model.',
      metadata: { stop_turn: true },
    });
  }
  return createOutboundMessage({
    channel: ctx.msg.channel,
    chat_id: ctx.msg.chat_id,
    text: `Switching model to: ${arg}`,
    metadata: { stop_turn: true },
  });
}

async function cmdModels(ctx: CommandContext) {
  return createOutboundMessage({
    channel: ctx.msg.channel,
    chat_id: ctx.msg.chat_id,
    text: 'Models list placeholder.',
    metadata: { stop_turn: true },
  });
}

async function cmdSkill(ctx: CommandContext) {
  const arg = ctx.args.trim();
  if (!arg) {
    return createOutboundMessage({
      channel: ctx.msg.channel,
      chat_id: ctx.msg.chat_id,
      text: 'Use `/skill <name>` to load or remove a skill.',
      metadata: { stop_turn: true },
    });
  }
  return createOutboundMessage({
    channel: ctx.msg.channel,
    chat_id: ctx.msg.chat_id,
    text: `Toggling skill: ${arg}`,
    metadata: { stop_turn: true },
  });
}

async function cmdSkills(ctx: CommandContext) {
  return createOutboundMessage({
    channel: ctx.msg.channel,
    chat_id: ctx.msg.chat_id,
    text: 'Skills list placeholder.',
    metadata: { stop_turn: true },
  });
}

async function cmdVersion(ctx: CommandContext) {
  const version = process.env.npm_package_version || '0.1.0';
  return createOutboundMessage({
    channel: ctx.msg.channel,
    chat_id: ctx.msg.chat_id,
    text: `nanobot v${version}`,
    metadata: { stop_turn: true },
  });
}
