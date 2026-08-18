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
  LineChartOutlined,
  CloudServerOutlined,
  NodeIndexOutlined,
  DashboardOutlined,
  BellOutlined,
  DollarOutlined,
  CloudUploadOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';

interface DocsLayoutProps {
  children: ReactNode;
}

interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  type?: 'group';
  children?: MenuItem[];
}

// 递归查找菜单项（支持嵌套 children / type='group'）
function findMenuItem(
  items: MenuItem[],
  predicate: (m: MenuItem) => boolean,
): MenuItem | undefined {
  for (const m of items) {
    if (predicate(m)) return m;
    if (m.children) {
      const hit = findMenuItem(m.children, predicate);
      if (hit) return hit;
    }
  }
  return undefined;
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

const observabilityMenu: MenuItem[] = [
  // ── SDK 埋点（@aipack-ai/observability） ──
  {
    key: 'group-sdk',
    type: 'group',
    label: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <LineChartOutlined /> SDK 埋点
      </span>
    ),
    children: [
      { key: '/observability#sdk-overview', label: '总览', icon: <RocketOutlined /> },
      { key: '/observability#setup', label: '1. 接入方式', icon: <ApiOutlined /> },
      { key: '/observability#events', label: '2. 事件一览', icon: <DashboardOutlined /> },
      { key: '/observability#trace', label: '3. Trace 设计', icon: <NodeIndexOutlined /> },
      { key: '/observability#metrics', label: '4. 生产指标口径', icon: <AimOutlined /> },
      { key: '/observability#s2', label: '5. 埋点上报与后台收集', icon: <DatabaseOutlined /> },
    ],
  },
  // ── Server 部署（@aipack-ai/observability-server） ──
  {
    key: 'group-server',
    type: 'group',
    label: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <CloudServerOutlined /> Server 部署
      </span>
    ),
    children: [
      { key: '/observability#server-overview', label: '总览', icon: <RocketOutlined /> },
      { key: '/observability#quickstart', label: '1. 快速开始', icon: <RocketOutlined /> },
      { key: '/observability#architecture', label: '2. 架构总览', icon: <ExperimentOutlined /> },
      { key: '/observability#storage', label: '3. 存储与聚合', icon: <DatabaseOutlined /> },
      { key: '/observability#api', label: '4. REST API', icon: <ApiOutlined /> },
      { key: '/observability#auth', label: '5. 用户与 RBAC', icon: <SafetyCertificateOutlined /> },
      { key: '/observability#alerts', label: '6. 告警系统', icon: <BellOutlined /> },
      { key: '/observability#cost', label: '7. 成本核算', icon: <DollarOutlined /> },
      { key: '/observability#archive', label: '8. 冷数据归档', icon: <CloudUploadOutlined /> },
      { key: '/observability#retention', label: '9. 数据保留', icon: <DatabaseOutlined /> },
      { key: '/observability#dashboard', label: '10. 内置面板', icon: <DashboardOutlined /> },
    ],
  },
];

const memoryMenu: MenuItem[] = [
  { key: '/memory#overview', label: '总览', icon: <RocketOutlined /> },
  { key: '/memory#quickstart', label: '1. 快速开始', icon: <ThunderboltOutlined /> },
  { key: '/memory#pipeline', label: '2. 数据流闭环', icon: <ApiOutlined /> },
  { key: '/memory#capture', label: '3. 自动捕获', icon: <DatabaseOutlined /> },
  { key: '/memory#injection', label: '4. 自动注入', icon: <ThunderboltOutlined /> },
  { key: '/memory#retrieval', label: '5. 混合检索', icon: <AimOutlined /> },
  { key: '/memory#tools', label: '6. Agent 工具', icon: <CodeOutlined /> },
  { key: '/memory#consolidation', label: '7. 记忆合并与修剪', icon: <ExperimentOutlined /> },
  { key: '/memory#ttl', label: '8. TTL 过期', icon: <ClockCircleOutlined /> },
  { key: '/memory#store-api', label: '9. Store API', icon: <ApiOutlined /> },
  { key: '/memory#custom-store', label: '10. 自定义 Store', icon: <DatabaseOutlined /> },
  { key: '/memory#events', label: '11. 事件监控', icon: <DashboardOutlined /> },
  { key: '/memory#config', label: '12. 插件配置全览', icon: <SettingOutlined /> },
];

const examplesMenu: MenuItem[] = [
  { key: '/examples', label: '最小示例', icon: <CodeOutlined /> },
  { key: '/examples#memory', label: '记忆集成', icon: <DatabaseOutlined /> },
  { key: '/examples#compression', label: '上下文压缩', icon: <AimOutlined /> },
  { key: '/examples#cli', label: 'CLI 配置', icon: <SettingOutlined /> },
];

const packagesMenu: MenuItem[] = [
  { key: '/packages', label: '包概览', icon: <AppstoreOutlined /> },
  { key: '/packages#aipack', label: 'aipack（核心）', icon: <RocketOutlined /> },
  { key: '/packages#memory', label: 'aipack-memory', icon: <DatabaseOutlined /> },
  { key: '/packages#compression', label: 'aipack-compression', icon: <AimOutlined /> },
  { key: '/packages#aipack-observability', label: 'aipack-observability', icon: <LineChartOutlined /> },
  { key: '/packages#aipack-observability-server', label: 'aipack-observability-server', icon: <CloudServerOutlined /> },
  { key: '/packages#cli', label: 'aipack-cli', icon: <SettingOutlined /> },
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
    else if (path === '/observability' || path.startsWith('/observability')) items = observabilityMenu;
    else if (path === '/memory' || path.startsWith('/memory')) items = memoryMenu;
    else if (path === '/examples' || path.startsWith('/examples')) items = examplesMenu;
    else if (path === '/packages' || path.startsWith('/packages')) items = packagesMenu;
    const selected = location.pathname + (location.hash || '');
    return {
      // 精确匹配优先，支持嵌套 children/group（递归查找）
      selectedKey:
        findMenuItem(items, (m) => m.key === selected)?.key ||
        findMenuItem(items, (m) => selected.startsWith(m.key))?.key ||
        path,
      // group 类型不需要 openKeys；平铺菜单保留原行为
      openKeys: items.filter((m) => m.type !== 'group').map((m) => m.key),
      rootPath: path,
    };
  }, [location.pathname, location.hash]);

  const currentMenu = (() => {
    if (rootPath === '/quickstart') return quickstartMenu;
    if (rootPath === '/api') return apiMenu;
    if (rootPath === '/extend') return extendMenu;
    if (rootPath === '/observability') return observabilityMenu;
    if (rootPath === '/memory') return memoryMenu;
    if (rootPath === '/examples') return examplesMenu;
    if (rootPath === '/packages') return packagesMenu;
    return [];
  })();

  const handleClick = ({ key }: { key: string }) => {
    const [path, hash] = key.split('#');
    const target = hash ? `${path}#${hash}` : path;
    if (target !== location.pathname + location.hash) {
      // navigate 触发 URL 变化；页面内部 useLocation().hash effect 会处理滚动
      navigate(target);
    }
    if (!hash) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    // 纯锚点直接滚动（如果 DOM 已渲染）；页面的 useLocation effect 也会兜底
    const el = document.getElementById(hash);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // （若 DOM 未渲染到，页面内部 useEffect(location.hash) 会在 50ms 后再试一次）
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
          items={currentMenu as any}
        />
      </aside>
      <main className="docs-content">
        <div className="docs-content-inner">{children}</div>
      </main>
    </div>
  );
}
