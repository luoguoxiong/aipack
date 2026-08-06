/**
 * apps/ai_blog_to_podcast_agent/src/tts.ts
 *
 * Edge TTS(微软神经语音)免费语音合成,无需 API Key。
 * 通过 WebSocket 调用 speech.platform.bing.com(Edge 浏览器"大声朗读"后端),
 * 协议移植自 rany2/edge-tts(Python)的 DRM + SSML + 二进制帧解析。
 *
 * 多层容错:连接失败重试 1 次;30s 超时;DRM token 基于 SHA256 动态生成(每 5 分钟轮换)。
 *
 * 协议要点(已实测验证):
 *   - WSS URL: wss://speech.platform.bing.com/.../edge/v1?TrustedClientToken=...&Sec-MS-GEC=<token>&Sec-MS-GEC-Version=1-143.0.3650.75
 *   - Sec-MS-GEC token: SHA256((unix秒 + WIN_EPOCH, 向下取整 300, ×1e7) + TRUSTED_TOKEN).hex.upper
 *   - 连接后发送两条消息:speech.config(JSON) + ssml(SSML)
 *   - 二进制帧:前 2 字节大端 = header 长度,然后 header 文本,然后 mp3 数据
 *   - 文本消息 Path:turn.end 表示合成结束
 */
import WebSocket from 'ws';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const EDGE_WS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.', 1)[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const WIN_EPOCH = 11644473600; // 1601-01-01 与 1970-01-01 的秒差
const TTS_TIMEOUT_MS = 30_000;
const TTS_RETRIES = 1;

export interface TtsOptions {
  text: string;
  /** Edge TTS 语音名称,默认 zh-CN-XiaoxiaoNeural */
  voice?: string;
  /** 语速,如 '+0%'、'+10%'、'-5%' */
  rate?: string;
  /** 音量,如 '+0%' */
  volume?: string;
}

export interface TtsResult {
  /** mp3 二进制 */
  audio: Buffer;
  /** 实际使用的语音 */
  voiceUsed: string;
}

/** 生成 Sec-MS-GEC DRM token(基于当前时间向下取整到 5 分钟 + SHA256) */
function generateSecMsGec(): string {
  let ticks = Math.floor(Date.now() / 1000); // unix 秒
  ticks += WIN_EPOCH; // 转为 Windows 文件时间 epoch
  ticks -= ticks % 300; // 向下取整到 5 分钟
  ticks = ticks * 1e7; // 转为 100 纳秒间隔(Windows 文件时间格式)
  return createHash('sha256').update(`${ticks}${TRUSTED_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

/** 生成随机 MUID(Cookie 用) */
function generateMuid(): string {
  return randomBytes(16).toString('hex').toUpperCase();
}

/** XML 转义 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 单次 Edge TTS 合成(不含重试) */
function synthesizeOnce(opts: TtsOptions): Promise<TtsResult> {
  return new Promise((resolve, reject) => {
    const text = opts.text.trim();
    if (!text) {
      reject(new Error('文本为空'));
      return;
    }
    const voice = opts.voice || 'zh-CN-XiaoxiaoNeural';
    const rate = opts.rate || '+0%';
    const volume = opts.volume || '+0%';

    const secMsGec = generateSecMsGec();
    const muid = generateMuid();
    const url = `${EDGE_WS_URL}?TrustedClientToken=${TRUSTED_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${encodeURIComponent(SEC_MS_GEC_VERSION)}`;

    const ws = new WebSocket(url, {
      headers: {
        Origin: ORIGIN,
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Cookie: `muid=${muid};`,
      },
      perMessageDeflate: false,
    });

    const audioChunks: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error('Edge TTS 超时(30s)'));
      }
    }, TTS_TIMEOUT_MS);

    ws.on('open', () => {
      const requestId = randomUUID().replace(/-/g, '');
      const timestamp = new Date().toISOString();

      // 1. speech.config
      const config =
        `X-Timestamp:${timestamp}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataOptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
                outputFormat: OUTPUT_FORMAT,
              },
            },
          },
        });
      ws.send(config);

      // 2. SSML
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name='${voice}'>` +
        `<prosody pitch='+0Hz' rate='${rate}' volume='${volume}'>${escapeXml(text)}</prosody>` +
        `</voice></speak>`;
      const ssmlMsg =
        `X-RequestId:${requestId}\r\n` +
        `X-Timestamp:${timestamp}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Stream-Type:Synth\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml;
      ws.send(ssmlMsg);
    });

    ws.on('message', (data, isBinary) => {
      if (settled) return;
      if (!isBinary) {
        const msg = (data as Buffer).toString();
        if (msg.includes('Path:turn.end')) {
          clearTimeout(timeout);
          settled = true;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          if (audioChunks.length === 0) {
            reject(new Error('Edge TTS 未返回音频(可能语音名无效或文本被拒)'));
          } else {
            resolve({ audio: Buffer.concat(audioChunks), voiceUsed: voice });
          }
        } else if (msg.includes('Path:turn.start')) {
          // 合成开始,无需处理
        }
      } else {
        // 二进制帧:前 2 字节大端 = header 长度,然后 header 文本,然后 mp3 数据
        const buf = data as Buffer;
        if (buf.length >= 2) {
          const headerLen = buf.readUInt16BE(0);
          const header = buf.slice(2, 2 + headerLen).toString();
          if (header.includes('Content-Type:audio/mpeg') || header.includes('Path:audio')) {
            audioChunks.push(buf.slice(2 + headerLen));
          }
        }
      }
    });

    ws.on('error', (err) => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      reject(new Error(`Edge TTS 连接失败: ${err.message}`));
    });
  });
}

/**
 * 调用 Edge TTS 合成语音。多层容错:连接失败重试 1 次。
 * 失败时抛出最后一次错误。
 */
export async function synthesizeSpeech(opts: TtsOptions): Promise<TtsResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= TTS_RETRIES; attempt++) {
    try {
      return await synthesizeOnce(opts);
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message || '';
      // 文本为空 / 语音无效等业务错误不重试
      if (msg.includes('未返回音频') || msg.includes('文本为空')) throw err;
      if (attempt < TTS_RETRIES) await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Edge TTS 失败');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 精选语音列表(供前端下拉),按语言分组。
 * 完整列表见 https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list
 */
export interface VoiceOption {
  id: string;
  name: string;
  lang: string;
}

export const VOICES: VoiceOption[] = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓(女·活泼)', lang: '中文(普通话)' },
  { id: 'zh-CN-YunxiNeural', name: '云希(男·阳光)', lang: '中文(普通话)' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊(女·温柔)', lang: '中文(普通话)' },
  { id: 'zh-CN-YunyangNeural', name: '云扬(男·新闻)', lang: '中文(普通话)' },
  { id: 'zh-CN-XiaohanNeural', name: '晓涵(女·成熟)', lang: '中文(普通话)' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北(女·东北话)', lang: '中文(方言)' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮(女·陕西话)', lang: '中文(方言)' },
  { id: 'zh-HK-HiuMaanNeural', name: '曉曼(女·粤语)', lang: '中文(粤语)' },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻(女·台湾)', lang: '中文(台湾)' },
  { id: 'en-US-AriaNeural', name: 'Aria(女·英文)', lang: '英文' },
  { id: 'en-US-GuyNeural', name: 'Guy(男·英文)', lang: '英文' },
  { id: 'en-US-EmmaMultilingualNeural', name: 'Emma(女·多语言)', lang: '多语言' },
  { id: 'ja-JP-NanamiNeural', name: '七海(女·日文)', lang: '日文' },
  { id: 'ko-KR-SunHiNeural', name: '선히(女·韩文)', lang: '韩文' },
];
