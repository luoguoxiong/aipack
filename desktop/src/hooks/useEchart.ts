import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export const useEchart = () => {
  const ref = useRef();
  const chartRef = useRef<echarts.ECharts>();

  useEffect(() => {
    if(ref.current){
      const chart = echarts.init(ref.current);
      chartRef.current = chart;
      const resizeObserver = new ResizeObserver(() => {
        chart.resize();
      });
      resizeObserver.observe(ref.current);
      return () => {
        resizeObserver.disconnect();
      };
    }
  }, [ref.current]);

  const setOption = async(option: any) => {
    setTimeout(() => {
      chartRef.current.setOption(option);
    }, 0);
  };

  return { ref, setOption, chartCurrent: chartRef.current };
};
