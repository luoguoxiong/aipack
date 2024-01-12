import React, { useEffect } from 'react';
import styles from './index.module.less';
import { useEchart } from '@/src/hooks';
interface LineIn{
  data: number[];
}
export const LineChart: React.FC<LineIn> = ({ data }) => {
  const { ref, setOption } = useEchart();
  useEffect(() => {
    if(ref.current ){
      const option = {
        grid: {
          top: 10,
          left: 0,
          right: 0,
          bottom: 0,
          containLabel: true,
        },
        xAxis: {
          type: 'category',
          show: false,
          data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        },
        yAxis: {
          type: 'value',
          show: false,
        },
        series: [
          {
            data: [820, 932, 901, 934, 1290, 1330, 1320],
            type: 'line',
            smooth: true,
          },
        ],
      };
      setOption(option);
    }
  }, [ref.current, data]);
  return (
    <div
      ref={ref}
      className={styles.wrap} />
  );
};


