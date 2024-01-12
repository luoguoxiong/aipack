/* eslint-disable react/require-default-props */
import React from 'react';
import { Spin } from 'antd';
import styles from './index.module.less';

export const Loading: React.FC<{style?: React.CSSProperties}> = ({ style }) => (
  <div
    className={styles.laoding}
    style={style}>
    <Spin style={{ height: 10 }} />
  </div>
);
