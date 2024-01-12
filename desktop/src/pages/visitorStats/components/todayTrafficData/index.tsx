import React, { useEffect, useState } from 'react';
import styles from './index.module.less';
import { TrafficItem } from './trafficItem';
import { Card } from '@/src/components';
import { getTodayTraffic } from '@/src/api';
interface TodayTrafficDataIn{
  appId: string;
}
export const TodayTrafficData: React.FC<TodayTrafficDataIn> = ({ appId }) => {
  const [data, setData] = useState<TodayTrafficRes>({
    allUsers: 0,
    pv: [0, 0],
    ip: [0, 0],
    newUsers: [0, 0],
    activeUsers: [0, 0],
  });
  const{ allUsers, newUsers, activeUsers, pv, ip } = data;
  useEffect(() => {
    getTodayTraffic(appId).then(({ data }) => {
      setData(data);
    });
  }, [appId]);


  return (
    <Card
      title="今日流量">
      <div className={styles.allStatus}>
        <div className={styles.statusNumWrap}>
          <TrafficItem
            title="用户总数"
            today={allUsers}
            lastDay={allUsers - newUsers[0]} />
          <TrafficItem
            title="活跃人数"
            today={activeUsers[0]}
            lastDay={activeUsers[1]} />
          <TrafficItem
            title="新用户数"
            today={newUsers[0]}
            lastDay={newUsers[1]} />
          <TrafficItem
            title="访问量"
            today={pv[0]}
            lastDay={pv[1]} />

          <TrafficItem
            title="IP"
            today={ip[0]}
            lastDay={ip[1]} />
        </div>
      </div>
    </Card>
  );
};
