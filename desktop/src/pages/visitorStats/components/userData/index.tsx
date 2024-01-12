import React, { useEffect, useState } from 'react';
import * as echarts from 'echarts';
import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import { Card } from '@/src/components';
import { useEchart } from '@/src/hooks';
import { getActiveUsers } from '@/src/api';
interface UserDataIn {
  appId: string;
}

export const UserData: React.FC<UserDataIn> = ({ appId }) => {
  const { ref, setOption } = useEchart();

  const [date, setDate] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs().add(-31, 'day'), dayjs()]);

  useEffect(() => {
    getActiveUsers({
      appId,
      beginTime: date[0].format('YYYY-MM-DD'),
      endTime: date[1].format('YYYY-MM-DD'),
    }).then(({ data }) => {
      const xAxis = data.map((item) => item.label);
      const values = data.map((item) => item.value);
      const maxValue = Math.max(...values as number[]);
      const option = {
        grid: {
          top: 40,
          left: 0,
          right: 0,
          bottom: 0,
          containLabel: true,
        },
        tooltip: {
          trigger: 'axis',
          axisPointer: {
            type: 'cross',
            crossStyle: {
              color: '#999',
            },
          },
        },
        toolbox: {
          feature: {
            dataView: { show: true, readOnly: false },
            magicType: { show: true, type: ['line', 'bar'] },
            restore: { show: true },
            saveAsImage: { show: true },
          },
        },
        xAxis: [
          {
            type: 'category',
            data: xAxis,
            axisPointer: {
              type: 'shadow',
            },
          },
        ],
        yAxis: [
          {
            type: 'value',
            min: 0,
            max: maxValue,
            interval: Math.ceil(maxValue / 5),
            axisLabel: {
              formatter: '{value}',
            },
          },
        ],
        series: [
          {
            name: '新用户',
            type: 'line',
            areaStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                {
                  offset: 0,
                  color: 'rgba(58,77,233,0.8)',
                },
                {
                  offset: 1,
                  color: 'rgba(58,77,233,0.3)',
                },
              ]),
            },
            tooltip: {
              valueFormatter: function(value) {
                return `${value }`;
              },
            },
            data: values,
          },
        ],
      };
      setOption(option);
    });
  }, [appId, date]);
  return (
    <Card
      title="新用户趋势"
      prefixHeadRight={
        <DatePicker.RangePicker
          value={date}
          disabledDate={(current) => {
            const today = dayjs(dayjs().format('YYYY-MM-DD')).add(1, 'day');
            return current.isAfter(today);
          }}
          onChange={(value) => {
            setDate(value);
          }} />
      }
    >
      <div
        style={{ height: 200 }}
        ref={ref} />
    </Card>
  );
};
