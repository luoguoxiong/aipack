import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  message,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { LinkOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from '../api';
import type { AppInfo, Span, TraceDetail, TraceItem } from '../types';

type StatusKey = '' | 'success' | 'error' | 'validation';

const STATUS_META: Record<string, { color: string; label: string }> = {
  success: { color: 'success', label: '成功' },
  error: { color: 'error', label: '失败' },
  validation: { color: 'warning', label: '校验失败' },
};

const KIND_META: Record<Span['kind'], { color: string; label: string }> = {
  run: { color: 'default', label: 'run' },
  model: { color: 'blue', label: 'model' },
  tool: { color: 'green', label: 'tool' },
};

export default function TracesPage() {
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [appId, setAppId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<StatusKey>('');
  const [sessionKey, setSessionKey] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<TraceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  /** 服务端配置的日志跳转模板（LOG_STREAM_URL_TEMPLATE），未配置则不显示"查看日志" */
  const [logStreamUrlTemplate, setLogStreamUrlTemplate] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.traces({
        appId,
        status: status || undefined,
        sessionKey: sessionKey.trim() || undefined,
        page,
        pageSize,
      });
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [appId, status, sessionKey, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api
      .listApps()
      .then(setApps)
      .catch(() => {});
    // 拉取面板元信息（日志跳转模板），失败静默（未配置则隐藏入口）
    api
      .meta()
      .then((m) => setLogStreamUrlTemplate(m.logStreamUrlTemplate))
      .catch(() => {});
  }, []);

  const onRowClick = async (traceId: string) => {
    setDetail(null);
    setDetailLoading(true);
    try {
      setDetail(await api.traceDetail(traceId));
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setDetailLoading(false);
    }
  };

  const columns = [
    {
      title: '时间',
      dataIndex: 'startedAt',
      width: 180,
      render: (v: number) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: 'traceId',
      dataIndex: 'traceId',
      width: 200,
      render: (v: string) => <span className="mono">{v.slice(0, 18)}…</span>,
    },
    {
      title: '应用',
      dataIndex: 'appId',
      width: 140,
      render: (v?: string) =>
        v ? (
          <Tag>{apps.find((a) => a.appId === v)?.name ?? v}</Tag>
        ) : (
          <Tag color="default">legacy</Tag>
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: TraceItem['status']) => (
        <Tag color={STATUS_META[v].color}>{STATUS_META[v].label}</Tag>
      ),
    },
    { title: '步数', dataIndex: 'turns', width: 70 },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      width: 110,
      render: (v: number) => `${v}ms`,
    },
    {
      title: 'Tokens',
      width: 140,
      render: (_: unknown, r: TraceItem) => `↑${r.tokens.input} ↓${r.tokens.output}`,
    },
    {
      title: '成本',
      dataIndex: 'costUsd',
      width: 90,
      render: (v?: number) => (v === undefined || v === null ? '—' : `$${Number(v).toFixed(6)}`),
    },
    {
      title: '重试',
      dataIndex: 'retries',
      width: 70,
      render: (v: number) => (v > 0 ? <Badge count={v} /> : '—'),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap>
          <Select
            value={appId}
            placeholder="全部应用"
            style={{ minWidth: 180 }}
            onChange={setAppId}
            allowClear
            options={apps.map((a) => ({ value: a.appId, label: a.name }))}
          />
          <Select
            value={status}
            placeholder="全部状态"
            style={{ minWidth: 130 }}
            onChange={setStatus}
            allowClear
            options={(Object.keys(STATUS_META) as StatusKey[])
              .filter((s) => s !== '')
              .map((s) => ({ value: s, label: STATUS_META[s].label }))}
          />
          <Input.Search
            placeholder="sessionKey 过滤"
            allowClear
            style={{ width: 220 }}
            onSearch={(v) => {
              setSessionKey(v);
              setPage(1);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
          </Button>
        </Space>
      </Card>

      <Card size="small" title={`Trace 列表（共 ${total} 条，点击行查看详情）`}>
        <Table
          size="small"
          rowKey="traceId"
          dataSource={items}
          columns={columns}
          loading={loading}
          rowClassName="clickable-row"
          onRow={(r) => ({
            onClick: () => onRowClick(r.traceId),
          })}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
            },
          }}
        />
      </Card>

      {/* Trace 详情抽屉 */}
      <Drawer
        title={detail ? `Trace: ${detail.traceId}` : 'Trace 详情'}
        width={560}
        open={!!detail}
        onClose={() => setDetail(null)}
        loading={detailLoading}
      >
        {detail ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {/* 日志关联入口（P1-1）：LOG_STREAM_URL_TEMPLATE 把 %s 替换为 traceId 跳转日志系统 */}
            {logStreamUrlTemplate ? (
              <a
                href={logStreamUrlTemplate.replace('%s', encodeURIComponent(detail.traceId))}
                target="_blank"
                rel="noreferrer"
              >
                <Button icon={<LinkOutlined />} size="small">
                  查看日志（traceId: {detail.traceId.slice(0, 18)}…）
                </Button>
              </a>
            ) : null}
            <Typography.Text type="secondary">Span 时间线（模型=蓝 / 工具=绿 / 错误=红）</Typography.Text>
            {detail.spans.length ? (
              detail.spans.map((s, i) => (
                <div
                  key={`${s.spanId}-${i}`}
                  style={{
                    display: 'flex',
                    gap: 12,
                    padding: '10px 12px',
                    background: '#fafafa',
                    borderRadius: 8,
                    borderLeft: `4px solid ${s.status === 'error' ? '#dc2626' : KIND_COLOR(s.kind)}`,
                  }}
                >
                  <Tag color={s.status === 'error' ? 'error' : KIND_META[s.kind].color}>
                    {s.status === 'error' ? `${KIND_META[s.kind].label}!` : KIND_META[s.kind].label}
                  </Tag>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, wordBreak: 'break-all' }} className="mono">
                      {s.name}
                    </div>
                    <div style={{ color: '#6b7280', fontSize: 12 }}>
                      {new Date(s.startedAt).toLocaleTimeString('zh-CN')} · {Math.round(s.durationMs)}ms
                      {s.errorClass ? ` · errorClass: ${s.errorClass}` : ''}
                    </div>
                    <div style={{ color: '#6b7280', fontSize: 12 }}>
                      tokens ↑{s.tokens.input} ↓{s.tokens.output}
                      {s.costUsd ? ` · $${Number(s.costUsd).toFixed(6)}` : ''}
                      {s.attempts && s.attempts > 1 ? ` · 重试 ${s.attempts - 1} 次` : ''}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <Empty description="无 span" />
            )}

            <Card size="small" title="说明">
              <Typography.Text type="secondary">
                Trace 即一次 run/stream：model span 含 tokens/成本/重试，tool span 含工具状态；
                同一 traceId 会持久化到会话消息，可在历史会话中复盘。
              </Typography.Text>
            </Card>
          </Space>
        ) : null}
      </Drawer>
    </Space>
  );
}

function KIND_COLOR(kind: Span['kind']): string {
  return kind === 'model' ? '#3b82f6' : kind === 'tool' ? '#22c55e' : '#9ca3af';
}
