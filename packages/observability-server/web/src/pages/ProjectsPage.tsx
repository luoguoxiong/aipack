import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import type { ProjectItem } from '../types';

/** 项目管理：列表 / 新建 / 切换 / 删除，切换后令牌自动轮换（X-Rotated-Token） */
export default function ProjectsPage() {
  const { projects, loadProjects, switchProject, currentProjectId } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await loadProjects();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadProjects]);

  useEffect(() => {
    load();
  }, [load]);

  const onCreate = async (values: { name: string }) => {
    setCreating(true);
    try {
      const project = await api.createProject(values.name);
      message.success(`项目 ${project.name} 已创建`);
      setCreateOpen(false);
      form.resetFields();
      await loadProjects();
      // 创建后后端已通过 X-Rotated-Token 轮换令牌，这里同步选中状态
      await switchProject(project.id);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const onDelete = async (project: ProjectItem) => {
    try {
      await api.deleteProject(project.id);
      message.success(`已删除项目 ${project.name}`);
      await loadProjects();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const onSwitch = async (project: ProjectItem) => {
    try {
      await switchProject(project.id);
      message.success(`已切换到项目 ${project.name}`);
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const columns = [
    {
      title: '项目名称',
      dataIndex: 'name',
      render: (v: string, project: ProjectItem) => (
        <Space>
          <Typography.Text strong>{v}</Typography.Text>
          {currentProjectId === project.id && <Typography.Text type="success">当前</Typography.Text>}
        </Space>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (v: number) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '操作',
      width: 280,
      render: (_: unknown, project: ProjectItem) => (
        <Space>
          <Button
            size="small"
            type={currentProjectId === project.id ? 'primary' : 'default'}
            onClick={() => onSwitch(project)}
          >
            {currentProjectId === project.id ? '当前' : '切换'}
          </Button>
          <Button size="small" onClick={() => navigate(`/projects/${project.id}/members`)}>
            成员
          </Button>
          <Popconfirm
            title="删除项目"
            description={`确认删除项目 ${project.name}？该操作不可恢复。`}
            okText="删除"
            okButtonProps={{ danger: true }}
            onConfirm={() => onDelete(project)}
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
            <PlusOutlined /> 项目管理
          </span>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建项目
            </Button>
          </Space>
        }
      >
        <Table
          size="small"
          rowKey="id"
          dataSource={projects}
          columns={columns}
          loading={loading}
          pagination={false}
        />
      </Card>

      <Modal
        title="新建项目"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={creating}
        okText="创建"
      >
        <Form form={form} onFinish={onCreate} layout="vertical" initialValues={{ name: '' }}>
          <Form.Item
            name="name"
            label="项目名称"
            rules={[{ required: true, message: '请输入项目名称' }]}
          >
            <Input placeholder="例如 my-project" maxLength={50} />
          </Form.Item>
          <Typography.Text type="secondary">
            创建后将自动切换到该项目，令牌（access token）会被轮换以携带新的项目上下文。
          </Typography.Text>
        </Form>
      </Modal>
    </Space>
  );
}
