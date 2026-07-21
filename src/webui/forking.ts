import crypto from 'crypto';
import {
  forkTranscriptBeforeUserIndex,
  writeSessionMessagesAsTranscript,
  appendForkMarker,
  deleteWebuiTranscript,
} from './transcript.js';

const WEBUI_CHAT_ID_RE = /^[A-Za-z0-9_:-]{1,64}$/;
const WEBUI_TITLE_METADATA_KEY = 'webui_title';

function validWebuiChatId(value: unknown): boolean {
  return typeof value === 'string' && WEBUI_CHAT_ID_RE.test(value);
}

function cleanGeneratedTitle(title: string | null | undefined): string | null {
  if (!title || typeof title !== 'string') return null;
  const cleaned = title.trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : null;
}

export function createWebuiChatFork(
  sessionManager: any,
  options: {
    sourceChatId: string;
    beforeUserIndex: number;
    title?: string | null;
  },
): [string, string] | null {
  const newId = crypto.randomUUID();
  const sourceKey = `websocket:${options.sourceChatId}`;
  const targetKey = `websocket:${newId}`;

  try {
    let forked: any = null;
    if (sessionManager && typeof sessionManager.forkSessionBeforeUserIndex === 'function') {
      forked = sessionManager.forkSessionBeforeUserIndex(
        sourceKey,
        targetKey,
        options.beforeUserIndex,
      );
    } else if (sessionManager && typeof sessionManager.getSession === 'function') {
      try {
        const sourceSession = sessionManager.getSession(sourceKey);
        if (sourceSession) {
          const messages = sourceSession.messages || [];
          let userCount = 0;
          let cutIndex = messages.length;
          for (let i = 0; i < messages.length; i++) {
            if (messages[i].role === 'user') {
              if (userCount === options.beforeUserIndex) {
                cutIndex = i;
                break;
              }
              userCount++;
            }
          }
          forked = {
            ...sourceSession,
            key: targetKey,
            messages: messages.slice(0, cutIndex),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            metadata: { ...(sourceSession.metadata || {}) },
          };
          if (typeof sessionManager.save === 'function') {
            sessionManager.save(forked);
          }
        }
      } catch {
        forked = null;
      }
    }

    if (!forked) return null;

    const transcriptOk = forkTranscriptBeforeUserIndex(
      sourceKey,
      targetKey,
      options.beforeUserIndex,
    );
    if (!transcriptOk && forked.messages) {
      writeSessionMessagesAsTranscript(targetKey, forked.messages);
    }
    appendForkMarker(targetKey);

    const forkTitle = cleanGeneratedTitle(options.title);
    if (forkTitle) {
      if (!forked.metadata) {
        forked.metadata = {};
      }
      forked.metadata[WEBUI_TITLE_METADATA_KEY] = forkTitle;
      if (typeof sessionManager?.save === 'function') {
        sessionManager.save(forked, { fsync: true });
      }
    }
  } catch (e) {
    deleteWebuiTranscript(targetKey);
    if (sessionManager && typeof sessionManager.deleteSession === 'function') {
      sessionManager.deleteSession(targetKey);
    }
    throw e;
  }

  return [newId, targetKey];
}
