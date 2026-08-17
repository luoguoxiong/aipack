import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  DollarOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { api } from '../api';
import type { AppInfo } from '../types';

export default function AppsPage() {
  const navigate = useNavigate();
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<AppInfo | null>(null);
  const [secretModal, setSecretModal] = useState<{ appId: string; appSecret: string } | null>(null);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setApps(await api.listApps());
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onCreate = async (values: { name: string }) => {
    setCreating(true);
    try {
      const app = await api.createApp(values.name);
      setCreated(app);
      setCreateOpen(false);
      form.resetFields();
      await load();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const onRegenerate = async (app: AppInfo) => {
    try {
      const res = await api.regenerateSecret(app.appId);
      setSecretModal({ appId: res.appId, appSecret: res.appSecret });
      message.success('已生成新密钥，旧密钥立即失效');
      await load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const onDelete = async (app: AppInfo) => {
    try {
      await api.deleteApp(app.appId);
      message.success(`已删除应用 ${app.name}`);
      await load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const onReveal = async (app: AppInfo) => {
    try {
      const res = await api.getSecret(app.appId);
      setSecretModal({ appId: res.appId, appSecret: res.appSecret });
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => message.success('已复制'),
      () => message.error('复制失败'),
    );
  };

  const columns = [
    {
      title: '应用名称',
      dataIndex: 'name',
      render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
    },
    {
      title: 'appId',
      dataIndex: 'appId',
      render: (v: string) => (
        <Space>
          <span className="mono">{v}</span>
          <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => copy(v)} />
        </Space>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (v: number) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '最近上报',
      dataIndex: 'lastSeenAt',
      width: 170,
      render: (v?: number) =>
        v ? (
          <Tooltip title={new Date(v).toLocaleString('zh-CN')}>
            <span>{timeAgo(v)}</span>
          </Tooltip>
        ) : (
          <Tag>从未上报</Tag>
        ),
    },
    {
      title: '操作',
      width: 240,
      render: (_: unknown, app: AppInfo) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => onReveal(app)}>
            查看密钥
          </Button>
          <Popconfirm
            title="重置密钥"
            description="旧密钥将立即失效，确认重置？"
            okText="重置"
            onConfirm={() => onRegenerate(app)}
          >
            <Button size="small" icon={<SyncOutlined />}>
              重置
            </Button>
          </Popconfirm>
          <Popconfirm
            title="删除应用"
            description={`删除后该应用的上报将被拒绝，确认删除 ${app.name}？`}
            okText="删除"
            okButtonProps={{ danger: true }}
            onConfirm={() => onDelete(app)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={
          <span>
            <PlusOutlined /> 应用管理
          </span>
        }
        extra={
          <Space>
            <Button icon={<DollarOutlined />} onClick={() => navigate('/model-prices')}>
              模型价格管理
            </Button>
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建应用
            </Button>
          </Space>
        }
      >
        <Table
          size="small"
          rowKey="appId"
          dataSource={apps}
          columns={columns}
          loading={loading}
          pagination={false}
        />
      </Card>

      {/* 新建应用 */}
      <Modal
        title="新建应用"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={creating}
        okText="创建"
      >
        <Form form={form} onFinish={onCreate} layout="vertical" initialValues={{ name: '' }}>
          <Form.Item
            name="name"
            label="应用名称"
            rules={[{ required: true, message: '请输入应用名称' }]}
          >
            <Input placeholder="例如 travel-app / blog-app" maxLength={50} />
          </Form.Item>
          <Typography.Text type="secondary">
            创建后将自动生成 appId 与 appSecret，用于接入
            <span className="mono"> @aipack-ai/observability</span> 上报 SDK。
          </Typography.Text>
        </Form>
      </Modal>

      {/* 创建成功 / 查看 / 重置密钥 */}
      <Modal
        title={created ? '创建成功' : '应用密钥'}
        open={!!created || !!secretModal}
        onCancel={() => {
          setCreated(null);
          setSecretModal(null);
        }}
        footer={[
          <Button
            key="close"
            type="primary"
            onClick={() => {
              setCreated(null);
              setSecretModal(null);
            }}
          >
            我已保存
          </Button>,
        ]}
      >
        {created || secretModal ? (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <div>
              <div style={{ marginBottom: 4 }}>
                <Typography.Text type="secondary">appId</Typography.Text>
              </div>
              <Space.Compact style={{ width: '100%' }}>
                <Input readOnly value={(created ?? secretModal)!.appId} className="secret-text" />
                <Button icon={<CopyOutlined />} onClick={() => copy((created ?? secretModal)!.appId)}>
                  复制
                </Button>
              </Space.Compact>
            </div>
            <div>
              <div style={{ marginBottom: 4 }}>
                <Typography.Text type="secondary">appSecret</Typography.Text>
              </div>
              <Space.Compact style={{ width: '100%' }}>
                <Input.Password readOnly value={(created ?? secretModal)!.appSecret} className="secret-text" />
                <Button icon={<CopyOutlined />} onClick={() => copy((created ?? secretModal)!.appSecret)}>
                  复制
                </Button>
              </Space.Compact>
            </div>
            {created && (
              <Typography.Text type="warning">
                ⚠️ 密钥仅此一次完整展示，请立即保存；如遗失可随时重置。
              </Typography.Text>
            )}
          </Space>
        ) : null}
      </Modal>
    </Space>
  );
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 3600_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / (24 * 3600_000))} 天前`;
}
