import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { BrowserRouter, HashRouter } from 'react-router-dom';

import { Monitor } from './sdk';
import App from './App';

// 监听 hashchange 事件，当 URL 中的哈希部分发生变化时触发
export interface PageModelIn {
  /** 应用AppId */
  appId: string;
  /** 是否是首屏 0 否 1 是 */
  isFirst: boolean;
  /** 访问Url路径 */
  pageUrl: string;
  /** 访问的域名 */
  origin?: string;
  /** 模拟用户ID */
  markUserId?: string;
  /** 用户ID */
  userId?: string;
  /** ip地址 */
  ip?: string;
  /** 浏览器名称 */
  browserName?: string;
  /** 浏览器版本号 */
  browserVersion?: string;
  /** 浏览器主版本 */
  browserMajors?: string;
  /** 系统名称 */
  osName?: string;
  /** 系统版本号 */
  osVersion?: string;
  /** 设备名称 */
  deviceVendor?: string;
  /** 设备模型 */
  deviceModel?: string;
  /** 页面Dns解析时长 */
  dnsTime?: number;
  /** 页面TCP链接时长 */
  tcpTime?: number;
  /** 页面白屏时间 */
  whiteTime?: number;
  /** 首次内容 */
  fcp?: number;
  /** 首字节时间 */
  ttfb?: number;
  /** 最大内容绘制 */
  lcp?: number;
  /** 用户首次与页面交互 */
  fid?: number;
  /** 页面请求完成时间 */
  province?: string;
  city?: string;
  country?: string;
  createdAt?: string;
  updatedAt?: string;
}
const testTask = () => {
// 构建带参数的 URL
  const apiUrl = 'http://localhost:7001/report';

  const params: PageModelIn = {
    appId: '0406afxf1704887270373',
    isFirst: true,
    origin: location.origin,
    pageUrl: `/${Math.floor(Math.random() * 100) + 1}`,
    userId: '',
    markUserId: `${Math.floor(Math.random() * 10000) + 10000}`,
    dnsTime: 20,
    tcpTime: 30,
    whiteTime: 40,
    fcp: 10,
    fid: 10,
    ttfb: 1,
    lcp: 10,
  };

  const queryString = new URLSearchParams(params).toString();
  const urlWithParams = `${apiUrl}?${queryString}`;
  // 发送 GET 请求
  fetch(urlWithParams, { method: 'get' })
    .then((response) => {
    // 处理响应
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
    // 处理返回的数据
      console.log(data);
    })
    .catch((error) => {
    // 处理错误
      console.error('Fetch error:', error);
    });
};

import('./app.css').then();
const index = 0;
// const id = setInterval(() => {
//   index++;
//   // if(index===201) clearInterval(id)
//   testTask();
// }, 10);

// testTask();
new Monitor({
  appId: 'wmyz',
  api: 'http://localhost:7001/test',
  cacheMax: 10,
  webVitalsTimeouts: 10000,
});


// 代码异常
const a = [{ a: 1 }, { a: [] }];
// const script = document.createElement('script');
// script.src = 'https://stest.com';
// document.body.appendChild(script);
// ===============
setTimeout(() => {
  a.map((item) => {
    item.a.map((temp) => {
      console.log(temp);
    });
  });
}, 0);
// fetch 监听异常
// fetch('/api/abc', {
//   method: 'get',
// }).then((res) => {
//   console.log('res', res);
// });
// ========================

// xmlhttp请求异常
// const xhr2 = new XMLHttpRequest();

// xhr2.onreadystatechange = (ev) => {
//   console.log('111',11);
// };
// // xhr2.open('post', '/desktop');
// xhr2.open("get", "/api/abc2", true);
// xhr2.setRequestHeader('header', '1');
// xhr2.send();
// ====================

// prmoise 异常
const promiseTest = () => new Promise((res, rej) => {
  rej(12);
});
promiseTest().then((res) => {
  console.log(res);
});

ReactDOM.render( <React.StrictMode>
  <BrowserRouter basename="/">
    <App />
  </BrowserRouter>
</React.StrictMode>, document.getElementById('root'));
