import { useState } from 'react';
import { Button, Card, Form, Input, message, Typography } from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';

/** 多用户模式注册页：注册成功后自动登录并跳转首页 */
export default function RegisterPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { email: string; password: string; name?: string }) => {
    setLoading(true);
    try {
      await api.register(values.email, values.password, values.name);
      // 注册后端已写入 cookie，这里再走一次登录以同步本地状态
      await login(values.email, values.password);
      message.success('注册成功，已自动登录');
      navigate('/', { replace: true });
    } catch (err) {
      message.error((err as Error).message || '注册失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-bg">
      <Card className="login-card">
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 40 }}>📊</div>
          <Typography.Title level={3} style={{ margin: '8px 0 0' }}>
            注册账号
          </Typography.Title>
          <Typography.Text type="secondary">aipack Observability</Typography.Text>
        </div>
        <Form onFinish={onFinish} size="large">
          <Form.Item
            name="email"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
          >
            <Input placeholder="邮箱" autoComplete="email" />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[
              { required: true, message: '请输入密码' },
              { min: 6, message: '密码至少 6 位' },
            ]}
          >
            <Input.Password placeholder="密码" autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="name">
            <Input placeholder="昵称（可选）" autoComplete="name" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" block loading={loading}>
              注册
            </Button>
          </Form.Item>
        </Form>
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Link to="/login">已有账号？去登录</Link>
        </div>
      </Card>
    </div>
  );
}
