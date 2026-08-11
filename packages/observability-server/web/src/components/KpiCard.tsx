import React from 'react';
import { Card, Statistic } from 'antd';

interface KpiCardProps {
  title: string;
  value: React.ReactNode;
  suffix?: string;
  precision?: number;
  color?: string;
  extra?: React.ReactNode;
}

export default function KpiCard({ title, value, suffix, precision, color, extra }: KpiCardProps) {
  return (
    <Card size="small" style={{ height: '100%' }} styles={{ body: { padding: 16 } }}>
      {typeof value === 'number' ? (
        <Statistic
          title={title}
          value={value}
          suffix={suffix}
          precision={precision}
          valueStyle={{ color: color ?? '#1f2937', fontSize: 22 }}
        />
      ) : (
        <>
          <div style={{ color: '#8c8c8c', fontSize: 13, marginBottom: 4 }}>{title}</div>
          <div style={{ fontSize: 22, fontWeight: 600, color: color ?? '#1f2937' }}>{value}</div>
        </>
      )}
      {extra && <div style={{ marginTop: 8, fontSize: 12 }}>{extra}</div>}
    </Card>
  );
}
