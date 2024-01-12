import React, { useEffect, useState } from 'react';
import * as echarts from 'echarts';
import { DatePicker, Select } from 'antd';
import dayjs from 'dayjs';
import { Card } from '@/src/components';
import { useEchart } from '@/src/hooks';
import { getTrafficDays } from '@/src/api';

interface TrafficTimeLine{
  appId: string;
  pages: Options[];
}
export const TrafficDayLine: React.FC<TrafficTimeLine> = ({ appId, pages }) => {
  const { ref, setOption } = useEchart();


  const [date, setDate] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs().add(-31, 'day'), dayjs().add(-1, 'day')]);

  const [page, setPage] = useState('');

  const getData = async() => {
    const { data: { pageViews, uniqueIPsCount, uniqueVisitors } } = await getTrafficDays({
      appId,
      beginTime: date[0].format('YYYY-MM-DD'),
      endTime: date[1].format('YYYY-MM-DD'),
      pageUrl: page,
    });

    const xAxis = Object.keys(pageViews).map((item) => dayjs(item).format('MM-DD'));

    const pv = Object.values(pageViews);

    const uv = Object.values(uniqueVisitors);

    const ip = Object.values(uniqueIPsCount);

    const maxValue = Math.max(...[...pv, ...uv, ...ip]);

    const option = {
      grid: {
        top: 40,
        left: 0,
        right: 20,
        bottom: 0,
        containLabel: true,
      },
      legend: {
        data: ['PV', 'UV', 'IP'],
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
          name: 'PV',
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
          data: pv,
        },
        {
          name: 'UV',
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
          data: uv,
        },
        {
          name: 'IP',
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
          data: ip,
        },
      ],
    };
    setOption(option);
  };

  useEffect(() => {
    getData();
  }, [appId, date, page]);
  return (
    <Card
      title="流量每日走势"
      prefixHeadRight={
        <>
          <Select
            style={{ minWidth: 100, marginRight: 10 }}
            onChange={(val) => {
              setPage(val);
            }}
            value={page}>
            {
              pages.map((item) => <Select.Option
                key={item.label}
                value={item.label === '全部' ? '' : item.label}>{item.label}</Select.Option>)
            }

          </Select>
          <DatePicker.RangePicker
            value={date}
            disabledDate={(current) => {
              const today = dayjs(dayjs().format('YYYY-MM-DD'));
              return current.isAfter(today);
            }}
            onChange={(value) => {
              setDate(value);
            }} />
        </>
      }
    >
      <div
        style={{ height: 200 }}
        ref={ref} />
    </Card>
  );
};
