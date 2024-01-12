import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from '@/src/app';

const root = ReactDOM.createRoot(document.getElementById('root'));

root.render(
  <ConfigProvider
    locale={zhCN}
    theme={{
      components: {
        Menu: {
          iconSize: 16,
          subMenuItemBg: '#4684ff',
          // 菜单项背景
          darkItemBg: '#4684ff',
          // 菜单项文字颜色
          darkItemColor: 'white',
          // 菜单项文字hover颜色
          darkItemHoverBg: 'rgba(255,255,255,0.2)',
          // 菜单项文字颜色Hover颜色
          darkItemHoverColor: 'rgba(255,255,255,0.8)',
          // 菜单项选中背景
          darkItemSelectedBg: 'rgba(255, 255, 255,0.5)',
          // 菜单项选中颜色
          darkItemSelectedColor: 'white',
          //
          darkSubMenuItemBg: '#4684ff',
        },
      },
    }}>
    <App />
  </ConfigProvider>
);
