export interface TrafficStatsIn{
  pageUrl:string
  count:number
}

export interface TrafficStatsRes{
  trafficPvStats:TrafficStatsIn[]
  trafficUvStats:TrafficStatsIn[]
  trafficIpStats:TrafficStatsIn[]
}

export type PageStats = Record<string, {
  pageUrl:string,
  pageViews: number,
  uniqueVisitors: number,
  uniqueIPsCount: number,
}>;

export interface PageStatsResult{
  pageUrl: string;
  pageViews: number;
  uniqueVisitors: number;
  uniqueIPsCount: number;
}

export interface TrafficStatsTimeQuery {
  beginTime: number;
  endTime: number;
}
export interface TrafficStatsQuery extends TrafficStatsTimeQuery {
  appId: string;
}

export interface PageModelIn {
  /** 应用AppId */
  appId:string
  /** 是否是首屏 0 否 1 是 */
  isFirst: boolean
  /** 访问Url路径 */
  pageUrl:string
  /** 访问的域名 */
  origin?:string
  /** 模拟用户ID */
  markUserId?:string
  /** 用户ID */
  userId?:string
  /** ip地址 */
  ip?:string
  /** 浏览器名称 */
  browserName?:string
  /** 浏览器版本号 */
  browserVersion?:string
  /** 浏览器主版本 */
  browserMajors?:string
  /** 系统名称 */
  osName?:string
  /** 系统版本号 */
  osVersion?:string
  /** 设备名称 */
  deviceVendor?:string
  /** 设备模型 */
  deviceModel?:string
  /** 页面Dns解析时长 */
  dnsTime?:number
  /** 页面TCP链接时长 */
  tcpTime?:number
  /** 页面白屏时间 */
  whiteTime?:number
  /** 首次内容 */
  fcp?:number;
  /** 首字节时间 */
  ttfb?:number;
  /** 最大内容绘制 */
  lcp?:number;
  /** 用户首次与页面交互 */
  fid?:number
  /** 页面请求完成时间 */
  province?:string,
  city?:string;
  country?:string
  createdAt?: string
  updatedAt?:string
}
