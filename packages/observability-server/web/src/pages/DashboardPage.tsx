import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Col,
  Empty,
  message,
  Row,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { EChartsOption } from 'echarts';
import { api } from '../api';
import type { AppInfo, Summary, TimeseriesPoint, ToolStat } from '../types';
import EChart from '../components/EChart';
import KpiCard from '../components/KpiCard';

type RangeKey = '1h' | '6h' | '24h' | '7d';
const RANGE_MS: Record<RangeKey, number> = {
  '1h': 3600_000,
  '6h': 6 * 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
};
const RANGE_STEP: Record<RangeKey, number> = {
  '1h': 60_000, // 1m
  '6h': 300_000, // 5m
  '24h': 900_000, // 15m
  '7d': 3600_000, // 1h
};

type MetricKey = 'requests' | 'successRate' | 'costUsd';
const METRIC_LABEL: Record<MetricKey, string> = {
  requests: '请求量',
  successRate: '成功率',
  costUsd: '成本($)',
};

const ERROR_CLASS_LABEL: Record<string, string> = {
  retryable: '可重试错误',
  timeout: '超时',
  auth: '鉴权错误',
  'context-overflow': '上下文溢出',
  'rate-limit': '限流',
  'invalid-request': '无效请求',
  unknown: '未知',
  tool_error: '工具错误',
  terminated: '已终止',
  validation: '校验失败',
};

export default function DashboardPage() {
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [appId, setAppId] = useState<string | undefined>(undefined);
  const [range, setRange] = useState<RangeKey>('6h');
  const [metric, setMetric] = useState<MetricKey>('requests');
  const [loading, setLoading] = useState(false);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [byModel, setByModel] = useState<Record<string, Summary> | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[]>([]);
  const [tools, setTools] = useState<ToolStat[]>([]);

  const params = useMemo(() => {
    const until = Date.now();
    return { appId, since: until - RANGE_MS[range], until };
  }, [appId, range]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sum, model, ts, toolList] = await Promise.all([
        api.summary(params),
        api.summary<Record<string, Summary>>({ ...params, groupBy: 'model' }),
        api.timeseries({ ...params, step: RANGE_STEP[range], metric }),
        api.tools(params),
      ]);
      setSummary(sum);
      setByModel(model);
      setTimeseries(ts);
      setTools(toolList);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [params, metric, range]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api
      .listApps()
      .then(setApps)
      .catch(() => {});
  }, []);

  // 时间序列图
  const tsOption: EChartsOption = useMemo(() => {
    const labels = timeseries.map((p) => formatTime(p.t, range));
    const values = timeseries.map((p) => p.v);
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 24, top: 24, bottom: 40 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { rotate: labels.length > 30 ? 40 : 0 },
      },
      yAxis: { type: 'value' },
      series: [
        {
          name: METRIC_LABEL[metric],
          type: 'line',
          smooth: true,
          areaStyle: { opacity: 0.12 },
          data: values,
          itemStyle: { color: '#3b82f6' },
        },
      ],
    };
  }, [timeseries, metric, range]);

  // 模型排行图（调用量 bar + 成本折线）
  const modelRows = useMemo(() => {
    if (!byModel) return [];
    return Object.entries(byModel)
      .map(([model, m]) => ({ model, calls: m.requests, costUsd: m.costUsd, avgMs: m.p95Ms }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 10);
  }, [byModel]);

  const modelOption: EChartsOption = useMemo(() => {
    const names = modelRows.map((r) => r.model);
    return {
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { left: 50, right: 60, top: 32, bottom: 40 },
      xAxis: { type: 'category', data: names, axisLabel: { rotate: names.length > 6 ? 30 : 0 } },
      yAxis: [
        { type: 'value', name: '调用量' },
        { type: 'value', name: '成本($)' },
      ],
      series: [
        {
          name: '调用量',
          type: 'bar',
          data: modelRows.map((r) => r.calls),
          itemStyle: { color: '#3b82f6' },
        },
        {
          name: '成本($)',
          type: 'line',
          yAxisIndex: 1,
          data: modelRows.map((r) => r.costUsd),
          itemStyle: { color: '#f59e0b' },
        },
      ],
    };
  }, [modelRows]);

  // 错误分析饼图
  const errorOption: EChartsOption = useMemo(() => {
    const entries = Object.entries(summary?.errorClasses ?? {});
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, type: 'scroll' },
      series: [
        {
          type: 'pie',
          radius: ['40%', '68%'],
          center: ['50%', '45%'],
          data: entries.map(([cls, count]) => ({ name: ERROR_CLASS_LABEL[cls] ?? cls, value: count })),
          label: { show: false },
        },
      ],
    };
  }, [summary]);

  // 重试分布（P2-2）：per-attempt 按 HTTP 状态码分类
  const retryEntries = useMemo(
    () => Object.entries(summary?.retryByStatus ?? {}).sort((a, b) => b[1] - a[1]),
    [summary],
  );

  const retryOption: EChartsOption = useMemo(
    () => ({
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 24, top: 24, bottom: 40 },
      xAxis: { type: 'category', data: retryEntries.map(([status]) => status) },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        {
          type: 'bar',
          data: retryEntries.map(([, count]) => count),
          itemStyle: { color: '#6d28d9' },
          label: { show: true, position: 'top' },
        },
      ],
    }),
    [retryEntries],
  );

  const toolColumns = [
    {
      title: '工具',
      dataIndex: 'tool',
      render: (v: string) => <span className="mono">{v}</span>,
    },
    {
      title: '调用次数',
      dataIndex: 'calls',
      width: 100,
      sorter: (a: ToolStat, b: ToolStat) => a.calls - b.calls,
    },
    {
      title: '成功率',
      dataIndex: 'successRate',
      width: 120,
      sorter: (a: ToolStat, b: ToolStat) => a.successRate - b.successRate,
      render: (v: number, r: ToolStat) => {
        const pct = Math.round(v * 100);
        return (
          <Tag color={pct === 100 ? 'success' : pct >= 80 ? 'processing' : 'error'}>
            {pct}%{r.errors > 0 ? `（${r.errors} 失败）` : ''}
          </Tag>
        );
      },
    },
    { title: '平均耗时', dataIndex: 'avgMs', width: 120, render: (v: number) => `${Math.round(v)}ms` },
  ];

  const hasError = Object.keys(summary?.errorClasses ?? {}).length > 0;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* 筛选器 */}
      <Card size="small">
        <Space wrap>
          <Select
            value={appId}
            placeholder="全部应用"
            style={{ minWidth: 200 }}
            onChange={setAppId}
            allowClear
            options={[
              ...apps.map((a) => ({ value: a.appId, label: `${a.name}（${a.appId}）` })),
            ]}
          />
          <Segmented
            value={range}
            onChange={(v) => setRange(v as RangeKey)}
            options={[
              { label: '近 1 小时', value: '1h' },
              { label: '近 6 小时', value: '6h' },
              { label: '近 24 小时', value: '24h' },
              { label: '近 7 天', value: '7d' },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
          </Button>
        </Space>
      </Card>

      {/* KPI 卡片 */}
      <Row gutter={[12, 12]}>
        <Col span={4}><KpiCard title="请求量" value={summary?.requests ?? 0} color="#2563eb" /></Col>
        <Col span={4}>
          <KpiCard
            title="成功率"
            value={summary ? Math.round(summary.successRate * 100) : 0}
            suffix="%"
            color={(summary?.successRate ?? 1) >= 0.95 ? '#16a34a' : '#dc2626'}
          />
        </Col>
        <Col span={4}>
          <KpiCard
            title="成本"
            value={summary ? Number(summary.costUsd.toFixed(6)) : 0}
            suffix="$"
            precision={summary && summary.costUsd >= 0.01 ? 4 : undefined}
            color="#d97706"
          />
        </Col>
        <Col span={4}>
          <KpiCard
            title="P95 耗时"
            value={summary ? Math.round(summary.p95Ms) : 0}
            suffix="ms"
            color={(summary?.p95Ms ?? 0) > 30000 ? '#dc2626' : '#1f2937'}
          />
        </Col>
        <Col span={4}>
          <KpiCard
            title="平均步数"
            value={summary ? Number(summary.avgTurns.toFixed(1)) : 0}
            color={(summary?.avgTurns ?? 0) > 8 ? '#dc2626' : '#1f2937'}
          />
        </Col>
        <Col span={4}>
          <KpiCard
            title="重试率"
            value={summary ? Math.round(summary.retryRate * 100) : 0}
            suffix="%"
            color="#6d28d9"
          />
        </Col>
      </Row>

      {/* 时间序列 + 模型排行 */}
      <Row gutter={[12, 12]}>
        <Col span={14}>
          <Card
            size="small"
            title="时间序列"
            extra={
              <Segmented
                size="small"
                value={metric}
                onChange={(v) => setMetric(v as MetricKey)}
                options={(Object.keys(METRIC_LABEL) as MetricKey[]).map((k) => ({
                  label: METRIC_LABEL[k],
                  value: k,
                }))}
              />
            }
          >
            {timeseries.length ? <EChart option={tsOption} height={280} /> : <Empty />}
          </Card>
        </Col>
        <Col span={10}>
          <Card size="small" title="模型排行（Top 10）">
            {modelRows.length ? <EChart option={modelOption} height={280} /> : <Empty />}
          </Card>
        </Col>
      </Row>

      {/* 工具分析 + 错误分析 */}
      <Row gutter={[12, 12]}>
        <Col span={14}>
          <Card size="small" title="工具分析（成功率升序，blocked/skipped 不计入分母）">
            <Table
              size="small"
              rowKey="tool"
              dataSource={tools}
              columns={toolColumns}
              pagination={false}
              locale={{ emptyText: <Empty description="暂无工具调用" /> }}
            />
          </Card>
        </Col>
        <Col span={10}>
          <Card size="small" title="错误分析">
            {hasError ? (
              <EChart option={errorOption} height={280} />
            ) : (
              <Empty description="无错误记录" />
            )}
          </Card>
        </Col>
      </Row>

      {summary?.permissionDenied ? (
        <Typography.Text type="secondary">
          权限拦截 {summary.permissionDenied} 次（未计入工具成功率分母）
        </Typography.Text>
      ) : null}

      {/* 重试分析（P2-2）：per-attempt 状态码分布 + 退避分位 */}
      <Row gutter={[12, 12]}>
        <Col span={14}>
          <Card size="small" title="重试分布（按 HTTP 状态码，per-attempt）">
            {retryEntries.length ? <EChart option={retryOption} height={260} /> : <Empty description="无重试记录" />}
          </Card>
        </Col>
        <Col span={10}>
          <Card size="small" title="重试退避时长">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Row gutter={[12, 12]}>
                <Col span={12}>
                  <KpiCard
                    title="退避 P50"
                    value={summary && summary.retryBackoffP50Ms > 0 ? Math.round(summary.retryBackoffP50Ms) : '—'}
                    suffix="ms"
                    color="#6d28d9"
                  />
                </Col>
                <Col span={12}>
                  <KpiCard
                    title="退避 P95"
                    value={summary && summary.retryBackoffP95Ms > 0 ? Math.round(summary.retryBackoffP95Ms) : '—'}
                    suffix="ms"
                    color="#7c3aed"
                  />
                </Col>
              </Row>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                每次重试之间的退避等待时长分位数。无重试数据时显示 0；告警可用 retryRate /
                retryByStatus 观察限流（429）与上游故障（5xx）趋势。
              </Typography.Text>
            </Space>
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

function formatTime(t: number, range: RangeKey): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (range === '7d') return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
