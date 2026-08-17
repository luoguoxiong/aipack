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
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
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
