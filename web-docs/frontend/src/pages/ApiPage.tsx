import { useMemo, useState } from 'react';
import { Input, Empty, Tag, Divider } from 'antd';
import { SearchOutlined, ApiOutlined } from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import { apiList, apiCategories, type ApiItem, type ApiParam } from '../data/apiData';

const badgeClassMap: Record<ApiItem['kind'], string> = {
  function: 'api-badge-function',
  class: 'api-badge-class',
  interface: 'api-badge-interface',
  type: 'api-badge-type',
};

const badgeLabelMap: Record<ApiItem['kind'], string> = {
  function: 'Function',
  class: 'Class',
  interface: 'Interface',
  type: 'Type',
};

function kindColor(kind: ApiItem['kind']) {
  switch (kind) {
    case 'function': return 'blue';
    case 'class': return 'magenta';
    case 'interface': return 'green';
    case 'type': return 'orange';
  }
}

function ParamTable({ params }: { params: ApiParam[] }) {
  return (
    <table className="params-table">
      <thead>
        <tr>
          <th style={{ width: '28%' }}>参数</th>
          <th style={{ width: '24%' }}>类型</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody>
        {params.map((p) => (
          <tr key={p.name}>
            <td>
              <span className="param-name">{p.name}</span>
              {p.required && <span className="param-required">必填</span>}
            </td>
            <td>
              <span className="param-type">{p.type}</span>
            </td>
            <td>{p.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ApiCard({ item }: { item: ApiItem }) {
  return (
    <div className="api-card" id={item.id}>
      <h3 className="api-title">
        <span>{item.name}</span>
        <Tag color={kindColor(item.kind)} className={`api-badge ${badgeClassMap[item.kind]}`} style={{ fontSize: 12 }}>
          {badgeLabelMap[item.kind]}
        </Tag>
      </h3>

      <div className="api-signature">{item.signature}</div>
      <p className="api-desc">{item.description}</p>

      {item.params && item.params.length > 0 && (
        <>
          <div style={{ fontWeight: 600, color: '#1e293b', marginBottom: 8 }}>参数</div>
          <ParamTable params={item.params} />
        </>
      )}

      {item.returns && (
        <div style={{ marginTop: 12 }}>
          <span style={{ fontWeight: 600, color: '#1e293b' }}>返回值：</span>
          <span style={{ color: '#475569' }}>{item.returns}</span>
        </div>
      )}

      {item.example && (
        <>
          <div style={{ fontWeight: 600, color: '#1e293b', marginTop: 16, marginBottom: 8 }}>示例</div>
          <CodeBlock code={item.example} language="typescript" />
        </>
      )}
    </div>
  );
}

export default function ApiPage() {
  const [keyword, setKeyword] = useState('');

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return null;
    return apiList.filter(
      (i) =>
        i.name.toLowerCase().includes(k) ||
        i.description.toLowerCase().includes(k) ||
        i.signature.toLowerCase().includes(k) ||
        i.category.toLowerCase().includes(k),
    );
  }, [keyword]);

  const grouped = useMemo(() => {
    const list = filtered ?? apiList;
    const map = new Map<string, ApiItem[]>();
    for (const cat of apiCategories) map.set(cat, []);
    for (const it of list) map.get(it.category)?.push(it);
    return map;
  }, [filtered]);

  const idMap: Record<string, string> = {
    'Runtime 核心': 'runtime',
    'Request 请求': 'request',
    'Session 会话': 'session',
    '多会话': 'sessions',
    '权限安全': 'permission',
    'AI 模型层': 'ai',
    'Extension 扩展': 'extension',
    'Transformer 转换器': 'transformer',
    'Pipeline 流水线': 'pipeline',
    'Result 结果': 'result',
  };

  return (
    <div>
      <h1 className="section-title">
        <ApiOutlined style={{ color: '#6366f1' }} /> API 文档
      </h1>
      <p className="section-subtitle">
        完整的 aipack 核心 API 列表，按模块分类展示。包含函数签名、参数说明、返回值和可运行示例。
      </p>

      <Input
        size="large"
        allowClear
        prefix={<SearchOutlined />}
        placeholder="搜索 API 名称、描述或签名…"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        style={{ marginBottom: 24, borderRadius: 12 }}
      />

      {filtered && filtered.length === 0 ? (
        <Empty description="没有匹配的 API" style={{ padding: '60px 0' }} />
      ) : (
        <div>
          {[...grouped.entries()].map(([cat, items]) => {
            if (!items.length) return null;
            return (
              <div key={cat} style={{ marginBottom: 32 }}>
                <Divider />
                <h2
                  className="subsection-title"
                  id={idMap[cat] || cat}
                  style={{ marginTop: 0, borderBottom: 'none', padding: 0, marginBottom: 20 }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      width: 4,
                      height: 22,
                      background: '#6366f1',
                      borderRadius: 2,
                      marginRight: 12,
                      verticalAlign: 'middle',
                    }}
                  />
                  {cat}
                  <Tag color="default" style={{ marginLeft: 12, fontSize: 12 }}>
                    {items.length} 个 API
                  </Tag>
                </h2>
                {items.map((it) => (
                  <ApiCard key={it.id} item={it} />
                ))}
              </div>
            );
          })}
        </div>
      )}

      <Divider />
      <div style={{ textAlign: 'center', color: '#64748b', padding: '24px 0' }}>
        共展示 {apiList.length} 个 API · 持续完善中。如有疑问可提交 Issue。
      </div>
    </div>
  );
}
