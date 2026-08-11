import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Layout, Menu, Spin, Typography } from 'antd';
import {
  AlertOutlined,
  AppstoreOutlined,
  DashboardOutlined,
  LogoutOutlined,
  ProfileOutlined,
} from '@ant-design/icons';
import { AuthProvider, useAuth } from './auth';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import AppsPage from './pages/AppsPage';
import TracesPage from './pages/TracesPage';
import AlertsPage from './pages/AlertsPage';

const { Sider, Header, Content } = Layout;

function Shell() {
  const { username, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const menuKey =
    location.pathname.startsWith('/apps') ? 'apps'
    : location.pathname.startsWith('/traces') ? 'traces'
    : location.pathname.startsWith('/alerts') ? 'alerts'
    : 'dashboard';

  const onLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" width={200}>
        <div
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: 16,
            fontWeight: 600,
            gap: 8,
          }}
        >
          📊 aipack Observability
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[menuKey]}
          onClick={({ key }) => navigate(key)}
          items={[
            { key: 'dashboard', icon: <DashboardOutlined />, label: '总览' },
            { key: 'apps', icon: <AppstoreOutlined />, label: '应用管理' },
            { key: 'traces', icon: <ProfileOutlined />, label: 'Trace 列表' },
            { key: 'alerts', icon: <AlertOutlined />, label: '告警' },
          ]}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 16,
            boxShadow: '0 1px 4px rgba(0,0,0,.06)',
          }}
        >
          <Typography.Text type="secondary">Agent 可观测面板</Typography.Text>
          <Typography.Text>{username}</Typography.Text>
          <Typography.Link onClick={onLogout}>
            <LogoutOutlined /> 退出
          </Typography.Link>
        </Header>
        <Content style={{ margin: 16 }}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/apps" element={<AppsPage />} />
            <Route path="/traces" element={<TracesPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

function Guard() {
  const { username, ready } = useAuth();
  const location = useLocation();

  if (!ready) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <Spin size="large" tip="加载中..." />
      </div>
    );
  }

  if (!username) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <Shell />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/*" element={<Guard />} />
      </Routes>
    </AuthProvider>
  );
}
