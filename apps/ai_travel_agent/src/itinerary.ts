/**
 * apps/ai_travel_agent/src/itinerary.ts
 *
 * 零依赖 ICS 日历文件生成。移植自 awesome-llm-apps ai_travel_agent 的 generate_ics_content:
 *   - 用正则拆 "Day N: ..." 为多天,每 Day 一个全天事件
 *   - 无匹配则整体作单事件
 *
 * ICS 规范要点(手写实现):CRLF 换行、文本转义(逗号/分号/换行)、日期格式 YYYYMMDD、
 * 全天事件用 VALUE=DATE 的 DTSTART/DTEND(DTEND 为次日)。
 */

/** Date → "YYYYMMDD" */
function toIcsDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** Date → "YYYYMMDDTHHMMSSZ" (UTC 时间戳) */
function toIcsStamp(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}T${h}${min}${s}Z`;
}

/** ICS 文本转义:反斜杠、分号、逗号、换行 → \\n */
function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

/** 折行(每 75 字节,首行续行前缀空格)—— ICS 规范要求 */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let rest = line;
  chunks.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 0) {
    chunks.push(' ' + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  return chunks.join('\r\n');
}

function event(lines: string[]): string {
  return lines.map(foldLine).join('\r\n');
}

/**
 * 从行程文本生成 ICS 字符串。
 * @param planText 行程文本(含 "Day N: ..." 段落)
 * @param startDate 起始日期(默认今天)
 */
export function generateIcs(planText: string, startDate: Date = new Date()): string {
  const dtstamp = toIcsStamp(new Date());
  const cal: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AI Travel Planner//agentpack//',
    'CALSCALE:GREGORIAN',
  ];

  // 匹配 "Day N:" (支持中英文冒号、Day 后空格),捕获到下一个 Day 或结尾
  const dayRe = /Day\s*(\d+)\s*[:：]\s*([\s\S]*?)(?=Day\s*\d+\s*[:：]|$)/gi;
  const days: Array<{ num: number; content: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = dayRe.exec(planText)) !== null) {
    days.push({ num: parseInt(m[1], 10), content: m[2].trim() });
  }

  if (days.length === 0) {
    // 无 Day 结构:整体作为单天事件
    cal.push(
      event([
        'BEGIN:VEVENT',
        'UID:travel-0@agentpack-ai-travel',
        `DTSTAMP:${dtstamp}`,
        'SUMMARY:Travel Itinerary',
        `DESCRIPTION:${escapeIcsText(planText.trim())}`,
        `DTSTART;VALUE=DATE:${toIcsDate(startDate)}`,
        `DTEND;VALUE=DATE:${toIcsDate(addDays(startDate, 1))}`,
        'END:VEVENT',
      ]),
    );
  } else {
    for (const day of days) {
      const current = addDays(startDate, day.num - 1);
      const next = addDays(current, 1);
      cal.push(
        event([
          'BEGIN:VEVENT',
          `UID:travel-day-${day.num}@agentpack-ai-travel`,
          `DTSTAMP:${dtstamp}`,
          `SUMMARY:Day ${day.num} Itinerary`,
          `DESCRIPTION:${escapeIcsText(day.content)}`,
          `DTSTART;VALUE=DATE:${toIcsDate(current)}`,
          `DTEND;VALUE=DATE:${toIcsDate(next)}`,
          'END:VEVENT',
        ]),
      );
    }
  }

  cal.push('END:VCALENDAR');
  return cal.join('\r\n');
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
