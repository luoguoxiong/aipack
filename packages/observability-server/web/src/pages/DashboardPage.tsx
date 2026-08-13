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
import type { AppInfo, Summary, TimeseriesPoint, ToolStat, VersionMetrics } from '../types';
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

type MetricKey = 'requests' | 'successRate' | 'tokensTotal';
const METRIC_LABEL: Record<MetricKey, string> = {
  requests: '请求量',
  successRate: '成功率',
  tokensTotal: 'Token 消耗量',
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
  const [version, setVersion] = useState<string | undefined>(undefined);
  const [range, setRange] = useState<RangeKey>('6h');
  const [metric, setMetric] = useState<MetricKey>('requests');
  const [loading, setLoading] = useState(false);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [byModel, setByModel] = useState<Record<string, Summary> | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[]>([]);
  const [tools, setTools] = useState<ToolStat[]>([]);
  /** 版本聚合（DB 直查，按 lastSeenAt 倒序）；供版本筛选与对比卡片 */
  const [versions, setVersions] = useState<VersionMetrics[]>([]);
  /** 对比卡片选择的版本；缺省取最近两个有数据的版本 */
  const [compareA, setCompareA] = useState<string | undefined>(undefined);
  const [compareB, setCompareB] = useState<string | undefined>(undefined);

  const params = useMemo(() => {
    const until = Date.now();
    return { appId, version, since: until - RANGE_MS[range], until };
  }, [appId, version, range]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sum, model, ts, toolList, versionList] = await Promise.all([
        api.summary(params),
        api.summary<Record<string, Summary>>({ ...params, groupBy: 'model' }),
        api.timeseries({ ...params, step: RANGE_STEP[range], metric }),
        api.tools(params),
        // 版本列表不随筛选变化（供切换/对比），仅按当前 appId + 时间范围
        api.versions({ appId: params.appId, since: params.since, until: params.until }),
      ]);
      setSummary(sum);
      setByModel(model);
      setTimeseries(ts);
      setTools(toolList);
      setVersions(versionList.items);
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

  // 对比卡片缺省取最近两个有数据的版本（versions 按 lastSeenAt 倒序）
  const effA = compareA ?? versions[0]?.version;
  const effB = compareB ?? (versions.length > 1 ? versions[1].version : versions[0]?.version);

  // 版本对比 delta 行
  const compareRows = useMemo(() => {
    const a = versions.find((v) => v.version === effA);
    const b = versions.find((v) => v.version === effB);
    if (!a || !b) return [];
    return compareVersions(a, b);
  }, [versions, effA, effB]);

  const versionOptions = useMemo(
    () =>
      versions.map((v) => ({
        value: v.version,
        label: v.version === 'unknown' ? 'unknown（旧数据）' : v.version,
      })),
    [versions],
  );

  // 对比表格列（标题随所选版本动态变化）
  const compareColumns = [
    { title: '指标', dataIndex: 'label', width: 220 },
    { title: effA ?? '—', dataIndex: 'a', width: 120 },
    { title: effB ?? '—', dataIndex: 'b', width: 120 },
    {
      title: 'Δ',
      dataIndex: 'delta',
      render: (v: string, r: CompareRow) => {
        const color = r.trend === 'up' ? '#16a34a' : r.trend === 'down' ? '#dc2626' : '#9ca3af';
        const arrow = r.trend === 'up' ? '↑' : r.trend === 'down' ? '↓' : '—';
        return (
          <span style={{ color, fontWeight: 600 }}>
            {arrow} {v}
          </span>
        );
      },
    },
  ];

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

  // 模型排行图（调用量 bar + token 消耗折线）
  const modelRows = useMemo(() => {
    if (!byModel) return [];
    return Object.entries(byModel)
      .map(([model, m]) => ({ model, calls: m.requests, totalTokens: m.totalTokens, avgMs: m.p95Ms }))
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
        { type: 'value', name: 'Token 消耗量' },
      ],
      series: [
        {
          name: '调用量',
          type: 'bar',
          data: modelRows.map((r) => r.calls),
          itemStyle: { color: '#3b82f6' },
        },
        {
          name: 'Token 消耗量',
          type: 'line',
          yAxisIndex: 1,
          data: modelRows.map((r) => r.totalTokens),
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
          <Select
            value={version}
            placeholder="全部版本"
            style={{ minWidth: 150 }}
            onChange={setVersion}
            allowClear
            options={versions.map((v) => ({
              value: v.version,
              label: v.version === 'unknown' ? 'unknown（旧数据）' : v.version,
            }))}
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
            title="Token 消耗量"
            value={summary?.totalTokens ?? 0}
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

      {/* 版本对比（跨版本指标对比，DB 全量聚合） */}
      <Card size="small" title="版本对比">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap>
            <span style={{ color: '#6b7280', fontSize: 12 }}>对比</span>
            <Select value={effA} placeholder="选择版本 A" style={{ minWidth: 150 }} onChange={setCompareA} options={versionOptions} />
            <span style={{ color: '#6b7280', fontSize: 12 }}>vs</span>
            <Select value={effB} placeholder="选择版本 B" style={{ minWidth: 150 }} onChange={setCompareB} options={versionOptions} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              基于当前 appId 与时间范围（DB 全量，非窗口内）；↑ 变好、↓ 变差
            </Typography.Text>
          </Space>
          {compareRows.length ? (
            <Table size="small" rowKey="key" dataSource={compareRows} columns={compareColumns} pagination={false} />
          ) : (
            <Empty description="数据不足两个版本，暂无可对比" />
          )}
        </Space>
      </Card>

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
            {version ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                模型维度数据未按版本细分，模型排行含全部版本；版本筛选仅作用于 KPI /
                时间序列 / 工具分析 / 错误分析
              </Typography.Text>
            ) : null}
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

// ─── 版本对比（纯函数）────────────────────────────────────────────

interface CompareRow {
  key: string;
  label: string;
  a: string;
  b: string;
  delta: string;
  /** 相对"更好"的方向：变好 / 变差 / 持平 */
  trend: 'up' | 'down' | 'flat';
}

const fmtInt = (n: number) => `${Math.round(n)}`;
const fmtPct = (n: number) => `${Math.round(n * 100)}%`;
const fmtMs = (n: number) => `${Math.round(n)}ms`;
const fmtFloat = (n: number) => n.toFixed(1);

/** 两版本指标 delta 表；better='down' 表示数值越小越好（耗时/步数/重试/错误） */
function compareVersions(a: VersionMetrics, b: VersionMetrics): CompareRow[] {
  const rows: CompareRow[] = [];
  const add = (
    key: string,
    label: string,
    av: number,
    bv: number,
    fmt: (n: number) => string,
    better: 'up' | 'down',
  ): void => {
    const d = bv - av;
    const flat = Math.abs(d) < 1e-9;
    rows.push({
      key,
      label,
      a: fmt(av),
      b: fmt(bv),
      delta: `${d > 0 ? '+' : ''}${fmt(d)}`,
      trend: flat ? 'flat' : better === 'up' ? (d > 0 ? 'up' : 'down') : d < 0 ? 'up' : 'down',
    });
  };

  add('requests', '请求量', a.requests, b.requests, fmtInt, 'up');
  add('successRate', '成功率', a.successRate, b.successRate, fmtPct, 'up');
  add('p95Ms', 'P95 耗时', a.p95Ms, b.p95Ms, fmtMs, 'down');
  const tokensPer = (v: VersionMetrics) => (v.requests > 0 ? v.totalTokens / v.requests : 0);
  add('tokensPerRequest', 'Token/请求', tokensPer(a), tokensPer(b), fmtInt, 'down');
  add('avgTurns', '平均步数', a.avgTurns, b.avgTurns, fmtFloat, 'down');
  add('retryRate', '重试率', a.retryRate, b.retryRate, fmtPct, 'down');
  const errSum = (v: VersionMetrics) => Object.values(v.errorClasses).reduce((s, n) => s + n, 0);
  add('errors', '错误次数', errSum(a), errSum(b), fmtInt, 'down');

  // 工具成功率对比：合并两版本工具，按总调用量取 Top 8；单侧无调用显示 —
  const toolNames = Array.from(new Set([...Object.keys(a.tools), ...Object.keys(b.tools)]));
  const calls = (v: VersionMetrics, name: string) => v.tools[name]?.calls ?? 0;
  toolNames.sort((x, y) => calls(a, y) + calls(b, y) - (calls(a, x) + calls(b, x)));
  for (const name of toolNames.slice(0, 8)) {
    const ta = a.tools[name];
    const tb = b.tools[name];
    const av = ta?.calls ? ta.successRate : undefined;
    const bv = tb?.calls ? tb.successRate : undefined;
    const d = av !== undefined && bv !== undefined ? bv - av : 0;
    rows.push({
      key: `tool:${name}`,
      label: `工具成功率 · ${name}`,
      a: av === undefined ? '—' : fmtPct(av),
      b: bv === undefined ? '—' : fmtPct(bv),
      delta: av !== undefined && bv !== undefined ? `${d > 0 ? '+' : ''}${fmtPct(d)}` : '—',
      trend:
        av === undefined || bv === undefined
          ? 'flat'
          : Math.abs(d) < 1e-9
            ? 'flat'
            : d > 0
              ? 'up'
              : 'down',
    });
  }
  return rows;
}
