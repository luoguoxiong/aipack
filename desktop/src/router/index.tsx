
import React, { Suspense, lazy, ComponentType } from 'react';
import { RouteObject } from 'react-router-dom';
import { AppstoreOutlined, BarChartOutlined, OrderedListOutlined, RadarChartOutlined, MedicineBoxOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Loading } from '@/src/components/loading';
const lazyLoad = (dynamicImport: () => Promise<{ default: ComponentType<any> }>) => {
  const Component = lazy(dynamicImport);
  return (
    <Suspense fallback={<Loading />}>
      <Component />
    </Suspense>
  );
};

export const munuRouters = [
  {
    path: '/',
    name: '应用列表',
    icon: AppstoreOutlined,
    element: lazyLoad(() => import('../pages/home')),
  },
];

export const hasAppRouters = [
  {
    path: '/visitorStats',
    name: '流量分析',
    icon: BarChartOutlined,
    element: lazyLoad(() => import('../pages/visitorStats')),
  },
  {
    path: '/performance',
    name: '性能分析',
    icon: ThunderboltOutlined,
    element: lazyLoad(() => import('../pages/visitorStats')),
  },
  {
    path: '/health',
    name: '健康情况',
    icon: MedicineBoxOutlined,
    element: lazyLoad(() => import('../pages/visitorStats')),
  },
  {
    path: '/topAnalyse',
    name: 'Top分析',
    icon: OrderedListOutlined,
    element: lazyLoad(() => import('../pages/topAnalyse')),
  },
  {
    path: '/geographicalDistribution',
    name: '地域分布',
    icon: RadarChartOutlined,
    element: lazyLoad(() => import('../pages/geographicalDistribution')),
  },
];

export const routes: RouteObject[] = [
  {
    path: '/login',
    element: lazyLoad(() => import('../pages/login')),
  },
  {
    path: '/',
    element: lazyLoad(() => import('../pages/content')),
    children: [
      ...munuRouters,
      ...hasAppRouters,
      {
        path: '/*',
        element: lazyLoad(() => import('@/src/pages/notFound')),
      },
    ],
  },
  {
    path: '/test',
    element: lazyLoad(() => import('../pages/home')),
  },
  {
    path: '*',
    element: lazyLoad(() => import('@/src/pages/notFound')),
  },
];


