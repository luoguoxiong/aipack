interface LoginRegsiterIn{
  account: string;
  password: string;
}

interface UserInfo{
  /** 用户ID */
  id?: number;
  /** 登录账号 */
  account: string;
  /** 加密登录密码 */
  encPassword: string;
  /** 账号状态 */
  status: 0 | 1;
  createdAt?: string;
  updatedAt?: string;
}

interface CreateAppIn{
  appType: number;
  appName: string;
}

interface UpdateAppInfo{
  appId: string;
  id: number;
  status: number;
}

interface AppInfo{
  id: number;
  appId: string;
  appName: string;
  createId: number;
  appType: number;
  status: number;
}

type TopKeys = 'webVisit' | 'browser' | 'deviceVendor' | 'city' | 'osName';

interface AnalyseReq{
  appId: string;
  date?: string;
  beginTime?: string;
  endTime?: string;
}
interface TopReq{
  appId: string;
  type?: TopKeys;
  top?: number;
}

interface Options{
  label: string;
  value: string|number;
}

interface TodayTrafficRes{
  allUsers: number;
  newUsers: [number, number];
  pv: [number, number];
  ip: [number, number];
  activeUsers: [number, number];
}

interface TrafficTimesReq{
  appId: string;
  date: string;
  pageUrl: string;
}

interface TrafficDaysReq{
  appId: string;
  pageUrl: string;
  beginTime: string;
  endTime: string;
}

interface TrafficTimesRes{
  pageViews: Record<string, number>;
  uniqueIPsCount: Record<string, number>;
  uniqueVisitors: Record<string, number>;
}
