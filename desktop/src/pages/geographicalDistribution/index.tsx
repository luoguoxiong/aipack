import React, { useEffect, useState } from 'react';
import * as echarts from 'echarts';
import { Table } from 'antd';
import styles from './index.module.less';
import { Card } from '@/src/components';
import { useAppStore, useEchart } from '@/src/hooks';
import { getWebVisitTop } from '@/src/api';
const GeographicalDistribution = () => {
  const { ref, setOption } = useEchart();
  const { active } = useAppStore();
  const [topData, setData] = useState([]);
  useEffect(() => {
    getWebVisitTop({
      appId: active,
      type: 'city',
    }).then(async({ data }) => {
      const map = (await import('@/src/utils/map')).default;
      echarts.registerMap('china', map as any);
      const mapData = {};
      const result = [];
      map.features.map(((item) => {
        const cityName = item.properties.name;
        const cp = item.properties.cp;
        mapData[cityName] = cp;
      }));


      const chinaTop = [];
      data.forEach((item, index) => {
        const str = `${item.label}`.substring(0, 2);
        if(item.label in mapData){
          chinaTop.push({
            label: item.label,
            value: item.value,
            sort: index + 1,
          });
          result.push({
            name: item.label,
            value: [...mapData[item.label], item.value],
          });
        } else if(str in mapData){
          chinaTop.push({
            label: str,
            value: item.value,
            sort: index + 1,
          });
          result.push({
            name: str,
            value: [...mapData[str], item.value],
          });
        }
      });
      setData(chinaTop);
      const option = {
        backgroundColor: '#0F1C3C',
        tooltip: {
          show: true,
          formatter: function(params) {
            if (params.value && params.value.length > 1) {
              return `&nbsp;&nbsp;${ params.name }&nbsp;&nbsp;&nbsp;${ params.value[2] }人&nbsp;&nbsp;`;
            } else {
              return null;
            }
          },

        },
        geo: {
          map: 'china',
          show: true,
          roam: false,
          label: {
            emphasis: {
              show: false,
            },
          },
          layoutSize: '100%',
          itemStyle: {
            normal: {
              borderColor: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{
                offset: 0,
                color: '#00F6FF',
              }, {
                offset: 1,
                color: '#53D9FF',
              }], false),
              borderWidth: 3,
              shadowColor: 'rgba(10,76,139,1)',
              shadowOffsetY: 0,
              shadowBlur: 60,
            },
          },
        },
        series: [{
          type: 'map',
          map: 'china',
          aspectScale: 0.75,
          label: {
            normal: {
              show: false,
              color: 'white',
            },
            emphasis: {
              show: false,
            },
          },
          itemStyle: {
            normal: {
              areaColor: {
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [{
                  offset: 0,
                  color: '#073684', // 0% 处的颜色
                }, {
                  offset: 1,
                  color: '#061E3D', // 100% 处的颜色
                }],
              },
              borderColor: '#215495',
              borderWidth: 1,
            },
            emphasis: {
              areaColor: {

                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [{
                  offset: 0,
                  color: '#073684', // 0% 处的颜色
                }, {
                  offset: 1,
                  color: '#061E3D', // 100% 处的颜色
                }],
              },
            },
          },
        },
        {

          // 设置为分散点
          type: 'scatter',
          // series坐标系类型
          coordinateSystem: 'geo',
          // 设置图形 'circle', 'rect', 'roundRect', 'triangle', 'diamond', 'pin', 'arrow'
          symbol: 'pin',
          // //标记的大小，可以设置成诸如 10 这样单一的数字，也可以用数组分开表示宽和高，例如 [20, 10] 表示标记宽为20，高为10
          // 气泡字体设置
          label: {
            normal: {
              show: true, // 是否显示
              textStyle: {
                color: '#fff', // 字体颜色
                fontSize: 10, // 字体大小
              },
              // 返回气泡数据
              formatter(value){
                return value.data.value[2];
              },
            },
          },
          itemStyle: {
            normal: {
              color: '#1E90FF', // 标志颜色
            },
          },
          // 给区域赋值
          data: result,
          symbolSize: function(vals) {
            return `${vals[2]}`.length * 7 + 20;
          },
          showEffectOn: 'render', // 配置何时显示特效。可选：'render' 绘制完成后显示特效。'emphasis' 高亮（hover）的时候显示特效。
          rippleEffect: { // 涟漪特效相关配置。
            brushType: 'stroke', // 波纹的绘制方式，可选 'stroke' 和 'fill'
          },
          hoverAnimation: true, // 是否开启鼠标 hover 的提示动画效果。
          zlevel: 1, // 所属图形的 zlevel 值
        },
        ],
      };
      setOption(option);
    });

  }, [active]);

  const columns = [
    {
      title: '排名',
      dataIndex: 'sort',
      key: 'sort',
    },
    {
      title: '省份',
      dataIndex: 'label',
      key: 'label',
    },
    {
      title: '访问量',
      dataIndex: 'value',
      key: 'value',
    },
  ];

  return (
    <div className={styles.content}>
      <div className={styles.map}>
        <Card title="省份排行榜">
          <div
            className={styles.body}
            ref={ref} />
        </Card>
      </div>
      <div className={styles.top}>
        <Card title="省份排行榜">
          <div
            className={styles.body}>
            <Table
              sticky
              dataSource={topData}
              pagination={false}
              columns={columns} />
          </div>
        </Card>
      </div>
    </div>
  );
};

export default GeographicalDistribution;
