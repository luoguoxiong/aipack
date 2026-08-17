import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
  Tabs,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import { CopyOutlined, LinkOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from '../api';
import type { AppInfo, RetryAttempt, Span, TraceDetail, TraceEvent, TraceItem } from '../types';
import TraceGantt from '../components/TraceGantt';

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
  /** Phase 9：从路由 :traceId 深链接自动打开详情（支持错误下钻跳转） */
  const { traceId: routeTraceId } = useParams<{ traceId?: string }>();
  const navigate = useNavigate();

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

  // 深链接：路由带 :traceId 时自动加载并打开详情抽屉
  useEffect(() => {
    if (!routeTraceId) return;
    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    api
      .traceDetail(routeTraceId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) message.error((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [routeTraceId]);

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
      title: '版本',
      dataIndex: 'appVersion',
      width: 110,
      render: (v?: string) =>
        v ? <span className="mono">{v}</span> : <Tag color="default">—</Tag>,
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
      width: 150,
      render: (_: unknown, r: TraceItem) => `↑${r.tokens.input} ↓${r.tokens.output}`,
    },
    {
      title: 'Token 总量',
      width: 110,
      render: (_: unknown, r: TraceItem) => {
        const t = r.tokens;
        const total = t.input + t.output + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
        return <span className="mono">{total}</span>;
      },
    },
    {
      title: '重试',
      dataIndex: 'retries',
      width: 70,
      render: (v: number) => (v > 0 ? <Badge count={v} /> : '—'),
    },
  ];

  // 瀑布图零点：trace 内最早 span 的起始时间
  const traceStartedAt = useMemo(() => {
    if (!detail || !detail.spans.length) return 0;
    return Math.min(...detail.spans.map((s) => s.startedAt));
  }, [detail]);

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
        width={620}
        open={!!detail}
        onClose={() => {
          setDetail(null);
          // 深链接关闭时清理路由参数，避免重开抽屉
          if (routeTraceId) navigate('/traces');
        }}
        loading={detailLoading}
      >
        {detail ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {/* Phase 9 跨系统链路信息块：w3cTraceId 可复制，parentTraceId 为 URL 时渲染外链 */}
            {detail.w3cTraceId || detail.parentTraceId ? (
              <Card size="small" title="跨系统链路" style={{ background: '#f0f9ff' }}>
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  {detail.w3cTraceId ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Typography.Text type="secondary">w3cTraceId:</Typography.Text>
                      <span className="mono" style={{ wordBreak: 'break-all' }}>
                        {detail.w3cTraceId}
                      </span>
                      <Button
                        size="small"
                        type="text"
                        icon={<CopyOutlined />}
                        onClick={() => copyText(detail.w3cTraceId!)}
                      />
                    </div>
                  ) : null}
                  {detail.parentTraceId ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <Typography.Text type="secondary">parentTraceId:</Typography.Text>
                      {isUrl(detail.parentTraceId) ? (
                        <a href={detail.parentTraceId} target="_blank" rel="noreferrer">
                          <LinkOutlined /> {detail.parentTraceId}
                        </a>
                      ) : (
                        <span className="mono" style={{ wordBreak: 'break-all' }}>
                          {detail.parentTraceId}
                        </span>
                      )}
                    </div>
                  ) : null}
                </Space>
              </Card>
            ) : null}

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

            {/* Span 视图：瀑布图 / 列表切换 */}
            <Tabs
              size="small"
              defaultActiveKey="gantt"
              items={[
                {
                  key: 'gantt',
                  label: '瀑布图',
                  children: detail.spans.length ? (
                    <TraceGantt spans={detail.spans} traceStartedAt={traceStartedAt} />
                  ) : (
                    <Empty description="无 span" />
                  ),
                },
                {
                  key: 'list',
                  label: '列表',
                  children: detail.spans.length ? (
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
                            {s.tokens.cacheRead || s.tokens.cacheWrite
                              ? ` · cache ↑${s.tokens.cacheRead} ↓${s.tokens.cacheWrite}`
                              : ''}
                            {s.attempts && s.attempts > 1 ? ` · 重试 ${s.attempts - 1} 次` : ''}
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <Empty description="无 span" />
                  ),
                },
              ]}
            />

            {/* P2-2 重试链（per-attempt）：每次重试的 provider/状态码/退避时长 */}
            {detail.retries?.length ? (
              <Card size="small" title={`重试明细（${detail.retries.length} 次 attempt）`}>
                <Table
                  size="small"
                  rowKey={(r: RetryAttempt) => `${r.timestamp}-${r.attempt}`}
                  dataSource={detail.retries}
                  pagination={false}
                  columns={[
                    { title: '模型', dataIndex: 'modelId', render: (v: string) => <span className="mono">{v}</span> },
                    {
                      title: '状态码',
                      dataIndex: 'status',
                      width: 80,
                      render: (v?: number) =>
                        v ? <Tag color={v >= 500 ? 'error' : v >= 400 ? 'warning' : 'default'}>{v}</Tag> : <Tag>unknown</Tag>,
                    },
                    { title: '错误', dataIndex: 'errorClass', width: 120, render: (v?: string) => v ?? '—' },
                    {
                      title: '退避',
                      dataIndex: 'delayMs',
                      width: 80,
                      render: (v?: number) => (v === undefined ? '—' : `${v}ms`),
                    },
                    {
                      title: '时间',
                      dataIndex: 'timestamp',
                      width: 130,
                      render: (v: number) => new Date(v).toLocaleTimeString('zh-CN'),
                    },
                  ]}
                />
              </Card>
            ) : null}

            {/* P2-1 自定义事件时间轴（emit 埋点，按时间升序） */}
            {detail.events?.length ? (
              <Card size="small" title={`事件时间轴（${detail.events.length} 条）`}>
                <Timeline
                  items={[...detail.events]
                    .sort((a, b) => a.timestamp - b.timestamp)
                    .map((e) => ({
                      color: 'blue',
                      children: (
                        <div>
                          <div style={{ fontWeight: 600 }} className="mono">
                            {e.name}
                            {e.sessionKey ? (
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                {' '}
                                · {e.sessionKey}
                              </Typography.Text>
                            ) : null}
                          </div>
                          <div style={{ color: '#6b7280', fontSize: 12 }}>
                            {new Date(e.timestamp).toLocaleString('zh-CN')}
                          </div>
                          {e.data !== undefined ? (
                            <pre
                              className="mono"
                              style={{
                                margin: '4px 0 0',
                                fontSize: 12,
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                                background: '#f5f5f5',
                                padding: 6,
                                borderRadius: 6,
                              }}
                            >
                              {formatEventData(e.data)}
                            </pre>
                          ) : null}
                        </div>
                      ),
                    }))}
                />
              </Card>
            ) : null}

            <Card size="small" title="说明">
              <Typography.Text type="secondary">
                Trace 即一次 run/stream：model span 含 tokens/重试，tool span 含工具状态；
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

/** 事件 data 渲染：对象 JSON 化并截断超长内容（避免撑爆抽屉） */
function formatEventData(data: unknown): string {
  if (typeof data === 'string') return data.length > 500 ? `${data.slice(0, 500)}…` : data;
  try {
    const s = JSON.stringify(data);
    return s && s.length > 500 ? `${s.slice(0, 500)}…` : s ?? 'null';
  } catch {
    return String(data);
  }
}

/** 复制文本到剪贴板并提示 */
function copyText(text: string): void {
  navigator.clipboard?.writeText(text).then(
    () => message.success('已复制'),
    () => message.error('复制失败'),
  );
}

/** 判断字符串是否为可跳转的 URL（http/https） */
function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}
