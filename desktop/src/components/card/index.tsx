import React from 'react';
import styles from './index.module.less';
interface CardIn{
  title: string;
  children: React.ReactNode;
  prefixHeadRight?: React.ReactNode;
}
export const Card: React.FC<CardIn> = ({ title, children, prefixHeadRight }) => (
  <div className={styles.card}>
    <div className={styles.head}>
      <span className={styles.title}>{title}</span>
      <div className={styles.prefixHeadRight}>{prefixHeadRight}</div>
    </div>
    <div className={styles.content} >
      {children}
    </div>
  </div>
);
