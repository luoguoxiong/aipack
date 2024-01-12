import React from 'react';
import styles from './index.module.less';

interface PeropleCounterIn{
  count: number;
}

export const PeropleCounter: React.FC<PeropleCounterIn> = ({ count }) => {
  const { color, showNumber, desc } = React.useMemo(() => {
    const colors = ['#3477ae', '#f67627', 'red'];
    const ranges = [ 10000, 100000000];
    const descTitle = ['', '万', '亿'];
    let index = 0;
    let prev = 0;
    while(index < ranges.length){
      const value = ranges[index];
      if(count >= prev && count < value){
        break;
      }
      prev = value;
      index++;
    }

    const color = colors[index];
    const showNumber = `${ index === 0 ? count : count / ranges[index - 1]}`;

    const pats = showNumber.split('.');

    if(pats.length === 2 && pats[1].length > 1) pats[1] = pats[1].substring(0, 1);

    const desc = descTitle[index];
    return { color, desc, showNumber: pats.join('.') };
  }, [count]);

  return (
    <span
      style={{ color }}
      className={styles.count}>
      {showNumber}<small>{desc}</small>
    </span>
  );
};
