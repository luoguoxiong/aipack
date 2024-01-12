import React, { useEffect, memo } from 'react';
import styles from './index.module.less';
import { useEchart } from '@/src/hooks';
interface LineIn{
  data: number[];
}
export const LineChart: React.FC<LineIn> = ({ data }) => {
  const { ref, setOption } = useEchart();
  useEffect(() => {
    if( data.length > 0){
      const option = {
        grid: {
          top: 2,
          left: 0,
          right: 0,
          bottom: -10,
          containLabel: true,
        },
        xAxis: {
          type: 'category',
          show: false,
          boundaryGap: false,
          data: data,
        },
        yAxis: {
          type: 'value',
          show: false, // 隐藏X轴
          min: 0,
        },
        series: [
          {
            type: 'line',
            smooth: true,
            symbol: 'none',
            areaStyle: {},
            data: data,
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

export const NewUserLine = memo(LineChart, (prev, next) => prev !== next);
