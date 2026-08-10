import { ReactNode, useMemo } from 'react';
import { Menu } from 'antd';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  RocketOutlined,
  ApiOutlined,
  ThunderboltOutlined,
  CodeOutlined,
  ExperimentOutlined,
  BoxPlotOutlined,
  SettingOutlined,
  DatabaseOutlined,
  RobotOutlined,
  AppstoreOutlined,
  SafetyCertificateOutlined,
  AimOutlined,
} from '@ant-design/icons';

interface DocsLayoutProps {
  children: ReactNode;
}

interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  children?: MenuItem[];
}

const quickstartMenu: MenuItem[] = [
  { key: '/quickstart', label: '安装与配置', icon: <ThunderboltOutlined /> },
  { key: '/quickstart#first-app', label: '创建第一个应用', icon: <RocketOutlined /> },
  { key: '/quickstart#streaming', label: '流式响应', icon: <AimOutlined /> },
  { key: '/quickstart#multi-turn', label: '多轮对话', icon: <BoxPlotOutlined /> },
];

const apiMenu: MenuItem[] = [
  { key: '/api#runtime', label: 'Runtime 核心', icon: <RobotOutlined /> },
  { key: '/api#request', label: 'Request 请求', icon: <ThunderboltOutlined /> },
  { key: '/api#session', label: 'Session 会话', icon: <DatabaseOutlined /> },
  { key: '/api#sessions', label: '多会话管理', icon: <BoxPlotOutlined /> },
  { key: '/api#permission', label: '权限安全', icon: <SafetyCertificateOutlined /> },
  { key: '/api#ai', label: 'AI 模型层', icon: <AppstoreOutlined /> },
  { key: '/api#extension', label: 'Extension 扩展', icon: <SettingOutlined /> },
  { key: '/api#transformer', label: 'Transformer 转换器', icon: <CodeOutlined /> },
  { key: '/api#result', label: 'Result 结果', icon: <ApiOutlined /> },
];

const extendMenu: MenuItem[] = [
  { key: '/extend', label: '扩展机制总览', icon: <SettingOutlined /> },
  { key: '/extend#tool', label: '自定义工具', icon: <CodeOutlined /> },
  { key: '/extend#extension', label: '自定义 Extension', icon: <ExperimentOutlined /> },
  { key: '/extend#transformer', label: '自定义 Transformer', icon: <BoxPlotOutlined /> },
  { key: '/extend#hooks', label: '工具调用钩子', icon: <SafetyCertificateOutlined /> },
];

const examplesMenu: MenuItem[] = [
  { key: '/examples', label: '最小示例', icon: <CodeOutlined /> },
  { key: '/examples#coding', label: 'Coding Agent', icon: <ExperimentOutlined /> },
  { key: '/examples#memory', label: '记忆集成', icon: <DatabaseOutlined /> },
  { key: '/examples#compression', label: '上下文压缩', icon: <AimOutlined /> },
  { key: '/examples#cli', label: 'CLI 配置', icon: <SettingOutlined /> },
];

const packagesMenu: MenuItem[] = [
  { key: '/packages', label: '包概览', icon: <AppstoreOutlined /> },
  { key: '/packages#aipack', label: 'aipack（核心）', icon: <RocketOutlined /> },
  { key: '/packages#coding', label: 'aipack-coding', icon: <CodeOutlined /> },
  { key: '/packages#memory', label: 'aipack-memory', icon: <DatabaseOutlined /> },
  { key: '/packages#compression', label: 'aipack-compression', icon: <AimOutlined /> },
  { key: '/packages#cli', label: 'aipack-cli', icon: <SettingOutlined /> },
  { key: '/packages#vscode', label: 'vscode-aipack-coding', icon: <ExperimentOutlined /> },
];

export default function DocsLayout({ children }: DocsLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const { selectedKey, openKeys, rootPath } = useMemo(() => {
    const path = location.pathname;
    let items: MenuItem[] = [];
    if (path === '/quickstart' || path.startsWith('/quickstart')) items = quickstartMenu;
    else if (path === '/api' || path.startsWith('/api')) items = apiMenu;
    else if (path === '/extend' || path.startsWith('/extend')) items = extendMenu;
    else if (path === '/examples' || path.startsWith('/examples')) items = examplesMenu;
    else if (path === '/packages' || path.startsWith('/packages')) items = packagesMenu;
    const selected = location.pathname + (location.hash || '');
    return {
      selectedKey: items.find((m) => selected.startsWith(m.key))?.key || path,
      openKeys: items.map((m) => m.key),
      rootPath: path,
    };
  }, [location.pathname, location.hash]);

  const currentMenu = (() => {
    if (rootPath === '/quickstart') return quickstartMenu;
    if (rootPath === '/api') return apiMenu;
    if (rootPath === '/extend') return extendMenu;
    if (rootPath === '/examples') return examplesMenu;
    if (rootPath === '/packages') return packagesMenu;
    return [];
  })();

  const handleClick = ({ key }: { key: string }) => {
    const [path, hash] = key.split('#');
    const target = hash ? `${path}#${hash}` : path;
    if (path !== location.pathname) {
      navigate(target);
    } else if (hash) {
      // 同页内跳转
      const el = document.getElementById(hash);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  if (rootPath === '/') {
    return <>{children}</>;
  }

  return (
    <div className="docs-layout">
      <aside className="docs-sidebar">
        <div style={{ padding: '0 20px 16px', fontSize: 12, fontWeight: 700, color: '#64748b', letterSpacing: 0.5 }}>
          文档导航
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          defaultOpenKeys={openKeys}
          onClick={handleClick}
          style={{ borderRight: 'none', background: 'transparent' }}
          items={currentMenu.map((m) => ({
            key: m.key,
            icon: m.icon,
            label: m.label,
          }))}
        />
      </aside>
      <main className="docs-content">
        <div className="docs-content-inner">{children}</div>
      </main>
    </div>
  );
}
