import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from 'antd';
import { GithubOutlined, BookOutlined, ThunderboltOutlined, RocketOutlined, CodeOutlined, LineChartOutlined, DatabaseOutlined } from '@ant-design/icons';

const navItems = [
  { path: '/', label: '首页', icon: <RocketOutlined /> },
  { path: '/quickstart', label: '快速开始', icon: <ThunderboltOutlined /> },
  { path: '/api', label: 'API 文档', icon: <BookOutlined /> },
  { path: '/extend', label: '扩展指南', icon: <CodeOutlined /> },
  { path: '/observability', label: '可观测性', icon: <LineChartOutlined /> },
  { path: '/memory', label: '持久化记忆', icon: <DatabaseOutlined /> },
  { path: '/examples', label: '示例代码', icon: <GithubOutlined /> },
  { path: '/packages', label: '包介绍', icon: <RocketOutlined /> },
];

export default function Navbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = location.pathname;

  return (
    <nav className="navbar">
      <div className="navbar-logo" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>
        <span style={{ fontSize: 24 }}>📦</span>
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
          v0.0.2
        </span>
      </div>
      <div className="navbar-links">
        {navItems.map((item) => {
          const isActive =
            item.path === '/'
              ? currentPath === '/'
              : currentPath.startsWith(item.path);
          return (
            <span
              key={item.path}
              className={`navbar-link ${isActive ? 'active' : ''}`}
              onClick={() => navigate(item.path)}
            >
              {item.icon} <span style={{ marginLeft: 4 }}>{item.label}</span>
            </span>
          );
        })}
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>
        <Button
          type="default"
          icon={<GithubOutlined />}
          onClick={() => window.open('https://github.com/luoguoxiong/aipack', '_blank')}
        >
          GitHub
        </Button>
      </div>
    </nav>
  );
}
