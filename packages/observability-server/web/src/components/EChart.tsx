import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

interface EChartProps {
  option: echarts.EChartsOption;
  height?: number;
  style?: React.CSSProperties;
  /** 事件回调：键为 echarts 事件名（如 'click'），值为处理函数 */
  onEvents?: Record<string, (params: any) => void>;
}

/** echarts 轻封装：挂载初始化、option 变化时更新、卸载销毁 */
export default function EChart({ option, height = 300, style, onEvents }: EChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);
    chartRef.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    // 修复：图表常在 Drawer/Tabs 等容器内挂载，挂载瞬间容器可能尚不可见（宽度为 0），
    // echarts.init 会以错误尺寸建画布且之后不再修正。
    // 用 ResizeObserver 监听容器自身尺寸，容器可见/变宽后 resize 重算画布宽度。
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) chart.resize();
    });
    ro.observe(el);
    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  // 注册/注销交互事件（onEvents 变化时重绑）
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !onEvents) return;
    const entries = Object.entries(onEvents);
    for (const [event, handler] of entries) {
      chart.on(event, handler);
    }
    return () => {
      for (const [event, handler] of entries) {
        chart.off(event, handler);
      }
    };
  }, [onEvents]);

  return <div ref={ref} style={{ width: '100%', height, ...style }} />;
}
