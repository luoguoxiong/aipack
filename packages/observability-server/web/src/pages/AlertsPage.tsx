import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  AlertOutlined,
  BellOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { api } from '../api';
import type { AlertEvent, AlertMetric, AlertOperator, AlertRule, AppInfo } from '../types';

const METRIC_OPTIONS: { value: AlertMetric; label: string }[] = [
  { value: 'successRate', label: '成功率' },
  { value: 'p95Ms', label: 'P95 耗时(ms)' },
  { value: 'avgTurns', label: '平均步数' },
  { value: 'retryRate', label: '重试率' },
  { value: 'permissionDenied', label: '权限拦截数' },
  { value: 'costUsd', label: '成本(USD)' },
  { value: 'requests', label: '请求量' },
  { value: 'toolSuccessRate', label: '工具成功率' },
  { value: 'errorClassCount', label: '错误分类计数' },
];

const OPERATOR_OPTIONS: { value: AlertOperator; label: string }[] = [
  { value: 'lt', label: '< 小于' },
  { value: 'lte', label: '≤ 小于等于' },
  { value: 'gt', label: '> 大于' },
  { value: 'gte', label: '≥ 大于等于' },
];

const WINDOW_OPTIONS = [
  { value: 5 * 60_000, label: '最近 5 分钟' },
  { value: 15 * 60_000, label: '最近 15 分钟' },
  { value: 30 * 60_000, label: '最近 30 分钟' },
  { value: 60 * 60_000, label: '最近 1 小时' },
  { value: 6 * 3600_000, label: '最近 6 小时' },
  { value: 24 * 3600_000, label: '最近 24 小时' },
];

const COOLDOWN_OPTIONS = [
  { value: 0, label: '不冷却' },
  { value: 5 * 60_000, label: '5 分钟' },
  { value: 10 * 60_000, label: '10 分钟' },
  { value: 30 * 60_000, label: '30 分钟' },
  { value: 3600_000, label: '1 小时' },
];

const METRIC_TAGS: Record<string, string> = {
  successRate: 'successRate',
  p95Ms: 'p95Ms',
  avgTurns: 'avgTurns',
  retryRate: 'retryRate',
  permissionDenied: 'permissionDenied',
  costUsd: 'costUsd',
  requests: 'requests',
  toolSuccessRate: 'toolSuccessRate',
  errorClassCount: 'errorClassCount',
};

function fmtMs(ms: number): string {
  if (ms % 3600_000 === 0) return `${ms / 3600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}

export default function AlertsPage() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<AlertRule | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventPage, setEventPage] = useState(1);
  const [eventPageSize, setEventPageSize] = useState(10);

  const [form] = Form.useForm();
  const metric = Form.useWatch('metric', form);

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      setRules(await api.alertRules());
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadApps = useCallback(async () => {
    try {
      setApps(await api.listApps());
    } catch {
      /* 应用列表加载失败不阻塞告警页 */
    }
  }, []);

  const loadEvents = useCallback(async (page: number, pageSize: number) => {
    setEventsLoading(true);
    try {
      const res = await api.alertEvents({
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      setEvents(res.items);
      setEventsTotal(res.total);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRules();
    loadApps();
  }, [loadRules, loadApps]);

  useEffect(() => {
    loadEvents(eventPage, eventPageSize);
  }, [eventPage, eventPageSize, loadEvents]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ lookbackMs: 15 * 60_000, cooldownMs: 10 * 60_000, enabled: true });
    setOpen(true);
  };

  const openEdit = (rule: AlertRule) => {
    setEditing(rule);
    form.setFieldsValue({ ...rule });
    setOpen(true);
  };

  const onSave = async (values: Partial<AlertRule>) => {
    setSaving(true);
    try {
      if (editing) {
        await api.updateAlertRule(editing.id, values);
        message.success('规则已更新');
      } else {
        await api.createAlertRule(values);
        message.success('规则已创建');
      }
      setOpen(false);
      await loadRules();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onToggle = async (rule: AlertRule, enabled: boolean) => {
    try {
      await api.updateAlertRule(rule.id, { enabled });
      await loadRules();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const onDelete = async (rule: AlertRule) => {
    try {
      await api.deleteAlertRule(rule.id);
      message.success(`已删除规则 ${rule.name}`);
      await loadRules();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const onTest = async (rule: AlertRule) => {
    try {
      await api.testAlertRule(rule.id);
      message.success('测试通知已发送');
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const ruleColumns = [
    {
      title: '规则名称',
      dataIndex: 'name',
      render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
    },
    {
      title: '指标',
      dataIndex: 'metric',
      width: 150,
      render: (v: string, r: AlertRule) => (
        <Space size={4} wrap>
          <Tag color="blue">{METRIC_TAGS[v] ?? v}</Tag>
          {r.metric === 'toolSuccessRate' && <Tag>{r.toolName}</Tag>}
          {r.metric === 'errorClassCount' && <Tag>{r.errorClass}</Tag>}
        </Space>
      ),
    },
    {
      title: '条件',
      width: 160,
      render: (_: unknown, r: AlertRule) => (
        <span className="mono">
          {r.operator === 'lt' && '<'}
          {r.operator === 'lte' && '≤'}
          {r.operator === 'gt' && '>'}
          {r.operator === 'gte' && '≥'} {r.threshold}
        </span>
      ),
    },
    {
      title: '回看窗口',
      dataIndex: 'lookbackMs',
      width: 110,
      render: (v: number) => fmtMs(v),
    },
    {
      title: '冷却',
      dataIndex: 'cooldownMs',
      width: 90,
      render: (v: number) => (v === 0 ? '不冷却' : fmtMs(v)),
    },
    {
      title: '应用',
      dataIndex: 'appId',
      width: 140,
      render: (v?: string) =>
        v ? <Tag>{v}</Tag> : <Typography.Text type="secondary">全局</Typography.Text>,
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (v: boolean, r: AlertRule) => (
        <Switch size="small" checked={v} onChange={(on) => onToggle(r, on)} />
      ),
    },
    {
      title: '操作',
      width: 190,
      render: (_: unknown, r: AlertRule) => (
        <Space>
          <Button size="small" icon={<ThunderboltOutlined />} onClick={() => onTest(r)}>
            测试
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          <Popconfirm
            title="删除规则"
            description={`确认删除规则 ${r.name}？`}
            okText="删除"
            okButtonProps={{ danger: true }}
            onConfirm={() => onDelete(r)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const eventColumns = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (v: number) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) =>
        v === 'fired' ? (
          <Tag color="red">触发</Tag>
        ) : (
          <Tag color="green">恢复</Tag>
        ),
    },
    { title: '规则', dataIndex: 'ruleName', render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    { title: '应用', dataIndex: 'appId', width: 140, render: (v?: string) => v ?? '全局' },
    {
      title: '指标值',
      width: 140,
      render: (_: unknown, e: AlertEvent) => (
        <span className="mono">
          {e.value} {e.operator} {e.threshold}
        </span>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={
          <span>
            <AlertOutlined /> 告警规则
          </span>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={loadRules} loading={loading}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建规则
            </Button>
          </Space>
        }
      >
        <Table
          size="small"
          rowKey="id"
          dataSource={rules}
          columns={ruleColumns}
          loading={loading}
          pagination={false}
        />
      </Card>

      <Card
        size="small"
        title={
          <span>
            <BellOutlined /> 告警事件
          </span>
        }
        extra={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => loadEvents(eventPage, eventPageSize)}
            loading={eventsLoading}
          >
            刷新
          </Button>
        }
      >
        <Table
          size="small"
          rowKey="id"
          dataSource={events}
          columns={eventColumns}
          loading={eventsLoading}
          pagination={{
            current: eventPage,
            pageSize: eventPageSize,
            total: eventsTotal,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50],
            onChange: (page, size) => {
              setEventPage(page);
              setEventPageSize(size);
            },
          }}
        />
      </Card>

      {/* 创建/编辑规则 */}
      <Modal
        title={editing ? `编辑规则：${editing.name}` : '新建告警规则'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={saving}
        okText={editing ? '保存' : '创建'}
        width={560}
      >
        <Form
          form={form}
          onFinish={onSave}
          layout="vertical"
          initialValues={{ lookbackMs: 15 * 60_000, cooldownMs: 10 * 60_000, enabled: true }}
        >
          <Form.Item name="name" label="规则名称" rules={[{ required: true, message: '请输入规则名称' }]}>
            <Input placeholder="例如：成功率低于 95% 告警" maxLength={50} />
          </Form.Item>
          <Space size={12} style={{ width: '100%' }} align="start">
            <Form.Item name="metric" label="指标" style={{ width: 200 }} rules={[{ required: true }]}>
              <Select options={METRIC_OPTIONS} />
            </Form.Item>
            <Form.Item name="operator" label="条件" style={{ width: 130 }} rules={[{ required: true }]}>
              <Select options={OPERATOR_OPTIONS} />
            </Form.Item>
            <Form.Item
              name="threshold"
              label="阈值"
              rules={[{ required: true, message: '请输入阈值' }]}
            >
              <InputNumber style={{ width: 140 }} step={0.01} />
            </Form.Item>
          </Space>
          {metric === 'toolSuccessRate' && (
            <Form.Item
              name="toolName"
              label="目标工具"
              rules={[{ required: true, message: '请输入工具名' }]}
            >
              <Input placeholder="例如：search_flights" />
            </Form.Item>
          )}
          {metric === 'errorClassCount' && (
            <Form.Item
              name="errorClass"
              label="错误分类"
              rules={[{ required: true, message: '请输入错误分类' }]}
            >
              <Input placeholder="例如：rate-limit / validation / tool_error" />
            </Form.Item>
          )}
          <Space size={12} style={{ width: '100%' }} align="start">
            <Form.Item name="lookbackMs" label="回看窗口" style={{ width: 200 }}>
              <Select options={WINDOW_OPTIONS} />
            </Form.Item>
            <Form.Item name="cooldownMs" label="通知冷却" style={{ width: 150 }}>
              <Select options={COOLDOWN_OPTIONS} />
            </Form.Item>
          </Space>
          <Form.Item name="appId" label="应用（缺省=全局）">
            <Select
              allowClear
              placeholder="全局（所有应用合并）"
              options={apps.map((a) => ({ value: a.appId, label: `${a.name} (${a.appId})` }))}
            />
          </Form.Item>
          <Form.Item
            name="webhookUrl"
            label="通知 webhook"
            tooltip="留空使用服务端全局 ALERTS_WEBHOOK_URL；支持企业微信/Slack/飞书等 JSON POST 接收方"
          >
            <Input placeholder="https://..." />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
