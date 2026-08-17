import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Layout, Menu, Select, Spin, Typography } from 'antd';
import {
  AlertOutlined,
  AppstoreOutlined,
  DashboardOutlined,
  LogoutOutlined,
  ProfileOutlined,
  ProjectOutlined,
  RobotOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { AuthProvider, useAuth } from './auth';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import DashboardPage from './pages/DashboardPage';
import AppsPage from './pages/AppsPage';
import TracesPage from './pages/TracesPage';
import AlertsPage from './pages/AlertsPage';
import ProjectsPage from './pages/ProjectsPage';
import ProjectMembersPage from './pages/ProjectMembersPage';
import AgentDefsPage from './pages/AgentDefsPage';
import ErrorClassDrillPage from './pages/ErrorClassDrillPage';
import ModelPricesPage from './pages/ModelPricesPage';

const { Sider, Header, Content } = Layout;

function Shell() {
  const { username, user, mode, currentProjectId, projects, switchProject, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const path = location.pathname;
  const menuKey =
    path.startsWith('/projects/') && path.includes('/members') ? 'members'
    : path.startsWith('/projects') ? 'projects'
    : path.startsWith('/agents') ? 'agents'
    : path.startsWith('/apps') ? 'apps'
    : path.startsWith('/traces') ? 'traces'
    : path.startsWith('/alerts') ? 'alerts'
    : 'dashboard';

  const onLogout = async () => {
    await logout();
    navigate('/login');
  };

  const onProjectChange = async (pid: string) => {
    try {
      await switchProject(pid);
    } catch (e) {
      // ignore: header select will keep current value
    }
  };

  // 多用户模式下，未选中项目且不在项目管理页时，提示先选择项目
  const needsProject =
    mode === 'multi' && !currentProjectId && !path.startsWith('/projects');

  const menuItems = [
    { key: 'dashboard', icon: <DashboardOutlined />, label: '总览' },
    { key: 'apps', icon: <AppstoreOutlined />, label: '应用管理' },
    { key: 'traces', icon: <ProfileOutlined />, label: 'Trace 列表' },
    { key: 'alerts', icon: <AlertOutlined />, label: '告警' },
    ...(mode === 'multi'
      ? [
          { key: 'projects', icon: <ProjectOutlined />, label: '项目' },
          ...(currentProjectId
            ? [{ key: 'members', icon: <TeamOutlined />, label: '成员' }]
            : []),
          { key: 'agents', icon: <RobotOutlined />, label: 'Agent 定义' },
        ]
      : []),
  ];

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
          items={menuItems}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            boxShadow: '0 1px 4px rgba(0,0,0,.06)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Typography.Text type="secondary">Agent 可观测面板</Typography.Text>
            {mode === 'multi' && (
              <>
                <Typography.Text type="secondary">·</Typography.Text>
                <Select
                  size="small"
                  style={{ minWidth: 180 }}
                  placeholder="选择项目"
                  value={currentProjectId ?? undefined}
                  onChange={onProjectChange}
                  options={projects.map((p) => ({ value: p.id, label: p.name }))}
                  notFoundContent="暂无项目"
                />
              </>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Typography.Text>{user?.email ?? username}</Typography.Text>
            <Typography.Link onClick={onLogout}>
              <LogoutOutlined /> 退出
            </Typography.Link>
          </div>
        </Header>
        <Content style={{ margin: 16 }}>
          {needsProject ? (
            <div style={{ display: 'grid', placeItems: 'center', minHeight: 400 }}>
              <div style={{ textAlign: 'center' }}>
                <Typography.Title level={4} type="secondary">
                  请先选择或创建一个项目
                </Typography.Title>
                <Typography.Link onClick={() => navigate('/projects')}>
                  前往项目管理 →
                </Typography.Link>
              </div>
            </div>
          ) : (
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/apps" element={<AppsPage />} />
              <Route path="/traces" element={<TracesPage />} />
              {/* Phase 9：从错误下钻等深链接打开 Trace 详情 */}
              <Route path="/traces/:traceId" element={<TracesPage />} />
              {/* Phase 9：错误归因下钻（列表 + 单错误类详情） */}
              <Route path="/error-classes" element={<ErrorClassDrillPage />} />
              <Route path="/error-classes/:cls" element={<ErrorClassDrillPage />} />
              {/* Phase 6：模型价格管理 */}
              <Route path="/model-prices" element={<ModelPricesPage />} />
              <Route path="/alerts" element={<AlertsPage />} />
              {mode === 'multi' && (
                <>
                  <Route path="/projects" element={<ProjectsPage />} />
                  <Route path="/projects/:pid/members" element={<ProjectMembersPage />} />
                  <Route path="/agents" element={<AgentDefsPage />} />
                </>
              )}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
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
        {/* 公共路由：登录与注册无需鉴权 */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        {/* 其余路由受 Guard 保护 */}
        <Route path="/*" element={<Guard />} />
      </Routes>
    </AuthProvider>
  );
}
