import React from 'react';
import styles from './index.module.less';
import { useAppStore } from '@/src/hooks';
import { TopBar } from '@/src/components';
const TopAnalyse = () => {
  const { active } = useAppStore();
  return (
    <div className={styles.wrap}>
      <div className={styles.item}>
        <TopBar
          title="网页访问量TOP"
          topKey="webVisit"
          appId={active} />
        <TopBar
          title="浏览器TOP"
          topKey="browser"
          appId={active} />
        <TopBar
          title="设备型号TOP"
          topKey="deviceVendor"
          appId={active} />
      </div>
      <div className={styles.item}>
        <TopBar
          title="省份分布TOP"
          topKey="city"
          appId={active} />
        <TopBar
          title="操作系统TOP"
          topKey="osName"
          appId={active} />
      </div>
    </div>
  );
};

export default TopAnalyse;
