import React, { useEffect } from 'react';
import { Card } from '@/src/components';
import { getWebVisitTop } from '@/src/api';
import { useEchart } from '@/src/hooks';
interface TopBarIn{
  appId: string;
  title: string;
  topKey: TopKeys;
}
export const TopBar: React.FC<TopBarIn> = ({ title, appId, topKey }) => {

  const { ref, setOption } = useEchart();

  useEffect(() => {
    getWebVisitTop({
      appId,
      top: 10,
      type: topKey,
    }).then(({ data }) => {
      const values = data.map((item) => Number(item.value));
      const labels = data.map((item) => item.label);
      const maxValue = Math.max(...values);
      setOption({
        tooltip: {
          trigger: 'axis',
          axisPointer: {
            type: 'shadow',
          },
        },
        grid: {
          top: 0,
          left: 0,
          right: 20,
          bottom: 0,
          containLabel: true,
        },
        xAxis: {
          type: 'value',
          max: maxValue,
          interval: Math.ceil(maxValue / 5),
        },
        yAxis: {
          type: 'category',
          data: labels,
        },
        series: [
          {
            type: 'bar',
            data: values,
          },
        ],
      });
    });
  }, [appId]);
  return (
    <Card title={title}>
      <div
        ref={ref}
        style={{ height: 200 }} />
    </Card>
  );
};
