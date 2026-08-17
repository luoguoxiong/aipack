import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import {
  Button,
  Card,
  Col,
  Empty,
  Row,
  Segmented,
  Select,
  Space,
  Table,
  Typography,
  message,
} from 'antd';
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import type { EChartsOption } from 'echarts';
import { api } from '../api';
import { fetchErrorClassDrill, fetchErrorClasses } from '../api';
import type { AppInfo, ErrorClassCountItem, ErrorClassDrillResult } from '../types';
import EChart from '../components/EChart';

// 时间范围快捷选项（与 DashboardPage 对齐）
type RangeKey = '1h' | '6h' | '24h' | '7d';
const RANGE_MS: Record<RangeKey, number> = {
  '1h': 3600_000,
  '6h': 6 * 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
};

// 错误类展示文案（与 DashboardPage 对齐）
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

const labelOf = (cls: string) => ERROR_CLASS_LABEL[cls] ?? cls;

export default function ErrorClassDrillPage() {
  const { cls } = useParams<{ cls?: string }>();
  const isDrill = !!cls;
  return isDrill ? <DrillView cls={cls!} /> : <ListView />;
}

// ── 列表模式：错误类 TopN ─────────────────────────────────────────

function ListView() {
  const navigate = useNavigate();
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [appId, setAppId] = useState<string | undefined>(undefined);
  const [range, setRange] = useState<RangeKey>('6h');
  const [items, setItems] = useState<ErrorClassCountItem[]>([]);
  const [loading, setLoading] = useState(false);

  const params = useMemo(() => {
    const until = Date.now();
    return { appId, since: until - RANGE_MS[range], until, limit: 20 };
  }, [appId, range]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await fetchErrorClasses(params));
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.listApps().then(setApps).catch(() => {});
  }, []);

  const total = useMemo(() => items.reduce((s, it) => s + it.count, 0), [items]);

  const columns = [
    {
      title: '错误类',
      dataIndex: 'errorClass',
      render: (v: string) => <span className="mono">{labelOf(v)}</span>,
    },
    {
      title: '原始标识',
      dataIndex: 'errorClass',
      render: (v: string) => <Typography.Text type="secondary" className="mono">{v}</Typography.Text>,
    },
    {
      title: '次数',
      dataIndex: 'count',
      width: 120,
      sorter: (a: ErrorClassCountItem, b: ErrorClassCountItem) => a.count - b.count,
      render: (v: number) => <Typography.Text strong>{v}</Typography.Text>,
    },
    {
      title: '占比',
      width: 120,
      render: (_: unknown, r: ErrorClassCountItem) =>
        total ? `${((r.count / total) * 100).toFixed(1)}%` : '—',
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap>
          <Select
            value={appId}
            placeholder="全部应用"
            style={{ minWidth: 200 }}
            onChange={setAppId}
            allowClear
            options={apps.map((a) => ({ value: a.appId, label: `${a.name}（${a.appId}）` }))}
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

      <Card size="small" title={`错误归因 TopN（共 ${items.length} 类，点击行下钻）`}>
        <Table
          size="small"
          rowKey="errorClass"
          dataSource={items}
          columns={columns}
          loading={loading}
          rowClassName="clickable-row"
          onRow={(r) => ({
            onClick: () => navigate(`/error-classes/${encodeURIComponent(r.errorClass)}`),
          })}
          locale={{ emptyText: <Empty description="无错误记录" /> }}
          pagination={false}
        />
      </Card>
    </Space>
  );
}

// ── 下钻模式：单错误类详情 ────────────────────────────────────────

function DrillView({ cls }: { cls: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  // 从列表跳转携带的次数（用于顶部展示；缺失时按 byModel 汇总回退）
  const stateCount = (location.state as { count?: number } | null)?.count;

  const [apps, setApps] = useState<AppInfo[]>([]);
  const [appId, setAppId] = useState<string | undefined>(undefined);
  const [range, setRange] = useState<RangeKey>('6h');
  const [data, setData] = useState<ErrorClassDrillResult | null>(null);
  const [loading, setLoading] = useState(false);

  const params = useMemo(() => {
    const until = Date.now();
    return { appId, since: until - RANGE_MS[range], until, limit: 100 };
  }, [appId, range]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchErrorClassDrill(cls, params));
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [cls, params]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.listApps().then(setApps).catch(() => {});
  }, []);

  // 总数：优先用列表带入的 count，否则汇总 byModel，再不行回退到最近 trace 数
  const total = useMemo(() => {
    if (stateCount !== undefined) return stateCount;
    const m = data ? Object.values(data.byModel).reduce((s, n) => s + n, 0) : 0;
    return m || data?.recentTraces.length || 0;
  }, [stateCount, data]);

  // 模型分布饼图
  const modelOption: EChartsOption = useMemo(() => {
    const entries = data ? Object.entries(data.byModel) : [];
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, type: 'scroll' },
      series: [
        {
          type: 'pie',
          radius: ['40%', '68%'],
          center: ['50%', '45%'],
          data: entries.map(([m, n]) => ({ name: m, value: n })),
          label: { show: false },
        },
      ],
    };
  }, [data]);

  // 工具分布柱状图
  const toolOption: EChartsOption = useMemo(() => {
    const entries = (data ? Object.entries(data.byTool) : []).sort((a, b) => b[1] - a[1]);
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 24, top: 16, bottom: 40 },
      xAxis: {
        type: 'category',
        data: entries.map(([t]) => t),
        axisLabel: { rotate: entries.length > 4 ? 30 : 0 },
      },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        {
          type: 'bar',
          data: entries.map(([, n]) => n),
          itemStyle: { color: '#f59e0b' },
          label: { show: true, position: 'top' },
        },
      ],
    };
  }, [data]);

  const traceColumns = [
    {
      title: '时间',
      dataIndex: 'startedAt',
      width: 170,
      render: (v: number) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: 'traceId',
      dataIndex: 'traceId',
      render: (v: string) => <span className="mono">{v.slice(0, 18)}…</span>,
    },
    {
      title: '模型',
      dataIndex: 'model',
      width: 160,
      render: (v?: string) => (v ? <span className="mono">{v}</span> : <Typography.Text type="secondary">—</Typography.Text>),
    },
    {
      title: '应用',
      dataIndex: 'appId',
      width: 130,
      render: (v?: string) =>
        v ? apps.find((a) => a.appId === v)?.name ?? v : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      width: 100,
      render: (v: number) => `${Math.round(v)}ms`,
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/error-classes')}>
            返回列表
          </Button>
          <Select
            value={appId}
            placeholder="全部应用"
            style={{ minWidth: 200 }}
            onChange={setAppId}
            allowClear
            options={apps.map((a) => ({ value: a.appId, label: `${a.name}（${a.appId}）` }))}
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

      {/* 顶部：错误类名 + 总数 */}
      <Card size="small">
        <Space align="center" size={20}>
          <Typography.Text type="secondary">错误类</Typography.Text>
          <Typography.Title level={4} style={{ margin: 0 }} className="mono">
            {labelOf(cls)}
          </Typography.Title>
          <Typography.Text type="secondary">·</Typography.Text>
          <Typography.Text type="secondary">原始标识</Typography.Text>
          <Typography.Text className="mono">{cls}</Typography.Text>
          <Typography.Text type="secondary">·</Typography.Text>
          <Typography.Text strong style={{ fontSize: 18 }}>
            总数 {total}
          </Typography.Text>
        </Space>
      </Card>

      <Row gutter={[12, 12]}>
        {/* 左侧：最近 trace 列表 */}
        <Col span={14}>
          <Card
            size="small"
            title={`最近 Trace（${data?.recentTraces.length ?? 0} 条，点击行查看详情）`}
          >
            <Table
              size="small"
              rowKey="traceId"
              dataSource={data?.recentTraces ?? []}
              columns={traceColumns}
              loading={loading}
              rowClassName="clickable-row"
              onRow={(r) => ({
                onClick: () => navigate(`/traces/${encodeURIComponent(r.traceId)}`),
              })}
              locale={{ emptyText: <Empty description="无最近 Trace" /> }}
              pagination={{ pageSize: 10, showSizeChanger: false, size: 'small' }}
            />
          </Card>
        </Col>
        {/* 右侧上：模型分布 */}
        <Col span={10}>
          <Card size="small" title="模型分布">
            {data && Object.keys(data.byModel).length ? (
              <EChart option={modelOption} height={260} />
            ) : (
              <Empty description="无模型分布" />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        {/* 右侧下：工具分布（占满一行，保持与上方网格对齐） */}
        <Col span={24}>
          <Card size="small" title="工具分布">
            {data && Object.keys(data.byTool).length ? (
              <EChart option={toolOption} height={240} />
            ) : (
              <Empty description="无工具分布" />
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
