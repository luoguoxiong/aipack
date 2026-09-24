import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Drawer } from 'antd';
import {
  GithubOutlined,
  MenuOutlined,
  BookOutlined,
  ThunderboltOutlined,
  RocketOutlined,
  CodeOutlined,
  LineChartOutlined,
  DatabaseOutlined,
  ApartmentOutlined,
  TagsOutlined,
  DeploymentUnitOutlined,
} from '@ant-design/icons';
import { useIsMobile } from '../hooks/useIsMobile';

const navItems = [
  { path: '/', label: '首页', icon: <RocketOutlined /> },
  { path: '/quickstart', label: '快速开始', icon: <ThunderboltOutlined /> },
  { path: '/api', label: 'API 文档', icon: <BookOutlined /> },
  { path: '/extend', label: '扩展指南', icon: <CodeOutlined /> },
  { path: '/observability', label: '可观测性', icon: <LineChartOutlined /> },
  { path: '/memory', label: '持久化记忆', icon: <DatabaseOutlined /> },
  { path: '/skills', label: 'Agent Skills', icon: <TagsOutlined /> },
  { path: '/multi-agent', label: '多Agent编排', icon: <ApartmentOutlined /> },
  { path: '/mcp', label: 'MCP 互操作', icon: <DeploymentUnitOutlined /> },
  { path: '/examples', label: '示例代码', icon: <GithubOutlined /> },
  { path: '/packages', label: '包介绍', icon: <RocketOutlined /> },
];

const GITHUB_URL = 'https://github.com/luoguoxiong/aipack';

export default function Navbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  const currentPath = location.pathname;

  // 路由变化（含浏览器前进/后退）时收起抽屉
  useEffect(() => {
    setMenuOpen(false);
  }, [currentPath]);

  const go = (path: string) => {
    setMenuOpen(false);
    navigate(path);
  };

  const renderNavList = () => (
    <div className="mobile-nav-list">
      {navItems.map((item) => {
        const isActive =
          item.path === '/' ? currentPath === '/' : currentPath.startsWith(item.path);
        return (
          <div
            key={item.path}
            className={`mobile-nav-item ${isActive ? 'active' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => go(item.path)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') go(item.path);
            }}
          >
            <span className="mobile-nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </div>
        );
      })}
      <Button
        block
        icon={<GithubOutlined />}
        style={{ marginTop: 12 }}
        onClick={() => window.open(GITHUB_URL, '_blank')}
      >
        GitHub 仓库
      </Button>
    </div>
  );

  return (
    <nav className="navbar">
      <div className="navbar-logo" onClick={() => go('/')} style={{ cursor: 'pointer' }}>
        <span style={{ fontSize: isMobile ? 20 : 24 }}>📦</span>
        <span>aipack</span>
        <span
          style={{
            fontSize: 11,
            background: '#eef2ff',
            color: '#4f46e5',
            padding: '2px 8px',
            borderRadius: 4,
            fontWeight: 600,
          }}
        >
          v{__APP_VERSION__}
        </span>
      </div>

      {!isMobile && (
        <div className="navbar-links">
          {navItems.map((item) => {
            const isActive =
              item.path === '/' ? currentPath === '/' : currentPath.startsWith(item.path);
            return (
              <span
                key={item.path}
                className={`navbar-link ${isActive ? 'active' : ''}`}
                onClick={() => go(item.path)}
              >
                {item.icon} <span style={{ marginLeft: 4 }}>{item.label}</span>
              </span>
            );
          })}
        </div>
      )}

      <div className="navbar-actions">
        {!isMobile && (
          <Button
            type="default"
            icon={<GithubOutlined />}
            onClick={() => window.open(GITHUB_URL, '_blank')}
          >
            GitHub
          </Button>
        )}
        {isMobile && (
          <Button
            className="navbar-menu-btn"
            type="text"
            icon={<MenuOutlined style={{ fontSize: 20 }} />}
            aria-label="打开导航菜单"
            onClick={() => setMenuOpen(true)}
          />
        )}
      </div>

      <Drawer
        className="nav-drawer"
        title={<span style={{ fontWeight: 700 }}>文档导航</span>}
        placement="right"
        width="78%"
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        styles={{ body: { padding: '8px 12px calc(16px + env(safe-area-inset-bottom))' } }}
      >
        {renderNavList()}
      </Drawer>
    </nav>
  );
}
