import React, { useMemo } from 'react';
import styles from './index.module.less';
import downPng from '@/src/images/down.png';
import upPng from '@/src/images/up.png';

interface TrafficItemIn{
  today: number;
  lastDay: number;
  title: string;
}

export const TrafficItem: React.FC<TrafficItemIn> = ({ today, lastDay, title }) => {
  const getPercent = (today: number, lastDay: number) => {
    const isUp = Number(today) > Number(lastDay);
    const value = Math.abs(today - lastDay);
    return { isUp, value: lastDay === 0 ? value : `${((value / lastDay) * 100).toFixed(2)}%` };
  };

  const { isUp, value } = useMemo(() => getPercent(today, lastDay), [today, lastDay]);
  return (
    <div className={styles.numItem}>
      <div className={styles.numItemTitle}>{title}</div>
      <div className={styles.numItemValue}>{today}</div>
      <div className={styles.lastDay}>
        <span>较昨日</span>
        <span className={isUp ? styles.up : styles.down}>{value}</span>
        <img
          src={isUp ? upPng : downPng}
          alt="" />
      </div>
    </div>
  );
};
