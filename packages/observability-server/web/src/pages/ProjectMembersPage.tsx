import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from '../api';
import type { ProjectMember } from '../types';

type Role = ProjectMember['role'];

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  editor: 'Editor',
  viewer: 'Viewer',
};

const ROLE_COLOR: Record<Role, string> = {
  owner: 'gold',
  editor: 'blue',
  viewer: 'default',
};

/** 项目成员管理：列表 / 邀请 / 改角色 / 移除 */
export default function ProjectMembersPage() {
  const { pid } = useParams<{ pid: string }>();
  const projectId = pid;
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      setMembers(await api.listMembers(projectId));
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const onInvite = async (values: { email: string; role: Role }) => {
    if (!projectId) return;
    setInviting(true);
    try {
      await api.inviteMember(projectId, values.email, values.role);
      message.success('已添加成员');
      setInviteOpen(false);
      form.resetFields();
      await load();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setInviting(false);
    }
  };

  const onRoleChange = async (member: ProjectMember, role: Role) => {
    if (!projectId) return;
    try {
      await api.updateMember(projectId, member.userId, role);
      message.success('已更新角色');
      await load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const onRemove = async (member: ProjectMember) => {
    if (!projectId) return;
    try {
      await api.removeMember(projectId, member.userId);
      message.success('已移除成员');
      await load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const columns = [
    {
      title: '邮箱',
      dataIndex: 'email',
      render: (v: string) => v || <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: '昵称',
      dataIndex: 'name',
      render: (v: string) => v || <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: '角色',
      dataIndex: 'role',
      width: 160,
      render: (role: Role, member: ProjectMember) =>
        role === 'owner' ? (
          <Tag color={ROLE_COLOR[role]}>{ROLE_LABEL[role]}</Tag>
        ) : (
          <Select
            size="small"
            value={role}
            onChange={(r) => onRoleChange(member, r)}
            options={[
              { value: 'editor', label: 'Editor' },
              { value: 'viewer', label: 'Viewer' },
            ]}
            style={{ width: 120 }}
          />
        ),
    },
    {
      title: '加入时间',
      dataIndex: 'grantedAt',
      width: 180,
      render: (v: number) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '操作',
      width: 100,
      render: (_: unknown, member: ProjectMember) =>
        member.role === 'owner' ? null : (
          <Popconfirm
            title="移除成员"
            description={`确认移除 ${member.email ?? member.userId}？`}
            okText="移除"
            okButtonProps={{ danger: true }}
            onConfirm={() => onRemove(member)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={<span>项目成员{projectId ? ` · ${projectId}` : ''}</span>}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
              刷新
            </Button>
            <Button type="primary" onClick={() => setInviteOpen(true)}>
              添加成员
            </Button>
          </Space>
        }
      >
        <Table
          size="small"
          rowKey="userId"
          dataSource={members}
          columns={columns}
          loading={loading}
          pagination={false}
        />
      </Card>

      <Modal
        title="添加成员"
        open={inviteOpen}
        onCancel={() => setInviteOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={inviting}
        okText="添加"
      >
        <Form form={form} onFinish={onInvite} layout="vertical" initialValues={{ role: 'viewer' }}>
          <Form.Item
            name="email"
            label="邮箱"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
          >
            <Input placeholder="member@example.com" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'editor', label: 'Editor（可读写）' },
                { value: 'viewer', label: 'Viewer（只读）' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
