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
  Table,
  Typography,
} from 'antd';
import { DeleteOutlined, DollarOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { createModelPrice, deleteModelPrice, fetchModelPrices } from '../api';
import type { ModelPrice } from '../types';

const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD' },
  { value: 'CNY', label: 'CNY' },
  { value: 'EUR', label: 'EUR' },
];

interface PriceFormValues {
  modelId: string;
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m?: number;
  cacheWritePer1m?: number;
  currency: string;
}

export default function ModelPricesPage() {
  const [prices, setPrices] = useState<ModelPrice[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<PriceFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPrices(await fetchModelPrices());
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onCreate = async (values: PriceFormValues) => {
    setSaving(true);
    try {
      await createModelPrice({
        modelId: values.modelId.trim(),
        inputPer1m: Number(values.inputPer1m),
        outputPer1m: Number(values.outputPer1m),
        cacheReadPer1m: values.cacheReadPer1m !== undefined ? Number(values.cacheReadPer1m) : 0,
        cacheWritePer1m: values.cacheWritePer1m !== undefined ? Number(values.cacheWritePer1m) : 0,
        currency: values.currency ?? 'USD',
        // 后端按接收时间戳生效；前端不强制指定 effectiveAt
        effectiveAt: Date.now(),
      });
      message.success('价格已创建');
      setOpen(false);
      form.resetFields();
      await load();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (p: ModelPrice) => {
    try {
      await deleteModelPrice(p.modelId, p.effectiveAt);
      message.success(`已删除 ${p.modelId} 的价格`);
      await load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const openCreate = () => {
    form.resetFields();
    form.setFieldsValue({ currency: 'USD' });
    setOpen(true);
  };

  const columns = [
    {
      title: '模型 ID',
      dataIndex: 'modelId',
      render: (v: string) => <Typography.Text strong className="mono">{v}</Typography.Text>,
    },
    {
      title: '输入 / 1M',
      dataIndex: 'inputPer1m',
      width: 130,
      render: (v: number) => <span className="mono">{fmtPrice(v)}</span>,
    },
    {
      title: '输出 / 1M',
      dataIndex: 'outputPer1m',
      width: 130,
      render: (v: number) => <span className="mono">{fmtPrice(v)}</span>,
    },
    {
      title: '缓存读 / 1M',
      dataIndex: 'cacheReadPer1m',
      width: 130,
      render: (v: number) => <span className="mono">{fmtPrice(v)}</span>,
    },
    {
      title: '缓存写 / 1M',
      dataIndex: 'cacheWritePer1m',
      width: 130,
      render: (v: number) => <span className="mono">{fmtPrice(v)}</span>,
    },
    {
      title: '币种',
      dataIndex: 'currency',
      width: 90,
      render: (v: string) => v ?? '—',
    },
    {
      title: '生效时间',
      dataIndex: 'effectiveAt',
      width: 170,
      render: (v: number) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '操作',
      width: 100,
      render: (_: unknown, p: ModelPrice) => (
        <Popconfirm
          title="删除价格"
          description={`确认删除 ${p.modelId} 的该条价格？`}
          okText="删除"
          okButtonProps={{ danger: true }}
          onConfirm={() => onDelete(p)}
        >
          <Button size="small" danger icon={<DeleteOutlined />}>
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={
          <span>
            <DollarOutlined /> 模型价格管理
          </span>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增价格
            </Button>
          </Space>
        }
      >
        <Table
          size="small"
          rowKey={(r: ModelPrice) => `${r.modelId}-${r.effectiveAt}`}
          dataSource={prices}
          columns={columns}
          loading={loading}
          pagination={false}
        />
      </Card>

      {/* 新增价格表单 */}
      <Modal
        title="新增模型价格"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={saving}
        okText="创建"
        width={520}
      >
        <Form
          form={form}
          onFinish={onCreate}
          layout="vertical"
          initialValues={{ currency: 'USD' }}
        >
          <Form.Item
            name="modelId"
            label="模型 ID"
            rules={[{ required: true, message: '请输入模型 ID' }]}
          >
            <Input placeholder="例如 gpt-4o / claude-3-5-sonnet" />
          </Form.Item>
          <Space size={12} style={{ width: '100%' }} align="start">
            <Form.Item
              name="inputPer1m"
              label="输入价格 / 1M tokens"
              rules={[{ required: true, message: '请输入输入价格' }]}
            >
              <InputNumber style={{ width: 200 }} min={0} step={0.01} addonAfter="$" />
            </Form.Item>
            <Form.Item
              name="outputPer1m"
              label="输出价格 / 1M tokens"
              rules={[{ required: true, message: '请输入输出价格' }]}
            >
              <InputNumber style={{ width: 200 }} min={0} step={0.01} addonAfter="$" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ width: '100%' }} align="start">
            <Form.Item name="cacheReadPer1m" label="缓存读 / 1M（可选）">
              <InputNumber style={{ width: 200 }} min={0} step={0.01} addonAfter="$" />
            </Form.Item>
            <Form.Item name="cacheWritePer1m" label="缓存写 / 1M（可选）">
              <InputNumber style={{ width: 200 }} min={0} step={0.01} addonAfter="$" />
            </Form.Item>
          </Space>
          <Form.Item name="currency" label="币种">
            <Select options={CURRENCY_OPTIONS} />
          </Form.Item>
          <Typography.Text type="secondary">
            价格单位为每 1M tokens 的金额；缓存项缺省按 0 记账。
          </Typography.Text>
        </Form>
      </Modal>
    </Space>
  );
}

// 价格统一保留 4 位小数展示
function fmtPrice(v: number): string {
  if (v === undefined || v === null) return '—';
  return Number(v).toFixed(4);
}
