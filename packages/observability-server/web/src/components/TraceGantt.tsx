import { useMemo } from 'react';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';
import { Empty } from 'antd';
import EChart from './EChart';

interface TraceGanttProps {
  spans: Array<{
    spanId: string;
    /** span 类型：run / model / tool */
    kind: string;
    name: string;
    startedAt: number;
    durationMs: number;
    status: string;
  }>;
  /** trace 起始时间，作为 x 轴零点 */
  traceStartedAt: number;
}

// span 类型颜色映射：run=蓝色 / model=绿色 / tool=橙色
const KIND_COLOR: Record<string, string> = {
  run: '#3b82f6',
  model: '#22c55e',
  tool: '#f59e0b',
};
const DEFAULT_COLOR = '#9ca3af';
const BAR_HEIGHT = 18;

// kind → 数值编码（供 custom series 的 value 数组使用）
const KIND_CODE: Record<string, number> = { run: 0, model: 1, tool: 2 };

/** ECharts custom series Gantt 瀑布图：每个 span 渲染为一个矩形条 */
export default function TraceGantt({ spans, traceStartedAt }: TraceGanttProps) {
  const option = useMemo<EChartsOption>(
    () => buildGanttOption(spans, traceStartedAt),
    [spans, traceStartedAt],
  );

  if (!spans.length) return <Empty description="无 span" />;

  // 高度随 span 数量自适应，保证可读性
  const height = Math.max(200, spans.length * 30);
  return <EChart option={option} height={height} />;
}

function buildGanttOption(
  spans: TraceGanttProps['spans'],
  traceStartedAt: number,
): EChartsOption {
  // 每个 span 一行；保留原始顺序，inverse 使首个 span 显示在顶部
  const categories = spans.map((s) => s.name);

  // data item：value 数组供 renderItem 通过 api.value() 读取，额外字段供 tooltip 使用
  const data = spans.map((s, i) => ({
    value: [
      i, // y 类目索引
      s.startedAt - traceStartedAt, // 起始偏移 ms
      s.startedAt - traceStartedAt + Math.max(s.durationMs, 1), // 结束偏移 ms
      KIND_CODE[s.kind] ?? 3, // kind 编码
      s.status === 'error' ? 1 : 0, // 是否错误
    ],
    name: s.name,
    kind: s.kind,
    status: s.status,
    durationMs: s.durationMs,
    spanId: s.spanId,
  }));

  return {
    tooltip: {
      trigger: 'item',
      formatter: (p: any) => {
        const d = p?.data;
        if (!d) return '';
        return [
          `<b>${escapeHtml(d.name)}</b>`,
          `类型: ${d.kind}`,
          `耗时: ${Math.round(d.durationMs)}ms`,
          `状态: ${d.status}`,
        ].join('<br/>');
      },
    },
    grid: { left: 8, right: 24, top: 16, bottom: 40, containLabel: true },
    xAxis: {
      type: 'value',
      name: '相对耗时 (ms)',
      nameLocation: 'middle',
      nameGap: 28,
    },
    yAxis: {
      type: 'category',
      data: categories,
      inverse: true,
      axisLabel: { width: 160, overflow: 'truncate', hideOverlap: false },
    },
    series: [
      {
        type: 'custom',
        renderItem: (params: any, api: any) => {
          const catIdx = api.value(0);
          const startX = api.value(1);
          const endX = api.value(2);
          const kindCode = api.value(3);
          const isError = api.value(4) === 1;

          const startPt = api.coord([startX, catIdx]);
          const endPt = api.coord([endX, catIdx]);

          const color =
            kindCode === 0
              ? KIND_COLOR.run
              : kindCode === 1
                ? KIND_COLOR.model
                : kindCode === 2
                  ? KIND_COLOR.tool
                  : DEFAULT_COLOR;

          const rect = {
            x: startPt[0],
            y: startPt[1] - BAR_HEIGHT / 2,
            width: Math.max(endPt[0] - startPt[0], 2),
            height: BAR_HEIGHT,
          };
          const sysRect = {
            x: params.coordSys.x,
            y: params.coordSys.y,
            width: params.coordSys.width,
            height: params.coordSys.height,
          };
          const clipped = echarts.graphic.clipRectByRect(rect, sysRect);
          if (!clipped) return { type: 'group', children: [] };
          return {
            type: 'rect',
            shape: clipped,
            style: {
              fill: color,
              stroke: isError ? '#dc2626' : 'transparent',
              lineWidth: isError ? 2 : 0,
            },
            styleEmphasis: {
              fill: color,
              stroke: isError ? '#dc2626' : '#1f2937',
              lineWidth: 2,
            },
          } as any;
        },
        encode: { x: [1, 2], y: 0 },
        data,
        cursor: 'pointer',
      },
    ],
  };
}

// 简易 HTML 转义，防止 span 名含特殊字符破坏 tooltip
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c] as string,
  );
}
