import * as sequelize from 'sequelize';

export interface TrafficModelIn {
  /** 应用AppId */
  appId:string
  /** 统计类型 1 分时统计 2 按日统计 */
  type: 1 | 2
  /** 访问Url路径 */
  pageUrl:string
  /** pv */
  pageViews:number
  /** uv 访问数量 */
  uniqueVisitors:number
  /** ip 访问数量 */
  uniqueIPsCount:number
  /** 统计时间 */
  statisticsTime: Date
  createdAt?: string
  updatedAt?:string
}

export const TrafficModel:sequelize.ModelAttributes = {
  id: { type: sequelize.INTEGER, primaryKey: true, autoIncrement: true },
  appId: {
    type: sequelize.STRING,
    allowNull: false,
    comment: '应用AppId',
  },
  pageUrl: {
    type: sequelize.STRING,
    allowNull: false,
    comment: '访问Url路径',
  },
  type: {
    type: sequelize.INTEGER(),
    allowNull: false,
    comment: '统计类型 1 分时统计 2 按日统计',
  },
  pageViews: {
    type: sequelize.STRING(),
    comment: 'PV',
  },
  uniqueVisitors: {
    type: sequelize.STRING(),
    comment: 'UV 访问数量',
  },
  uniqueIPsCount: {
    type: sequelize.STRING(),
    comment: 'IP 访问数量',
  },
  statisticsTime: {
    type: sequelize.DATE,
    comment: '统计的开始时间',
  },
  createdAt: {
    type: sequelize.DATE,
    comment: '创建日期',
  },
};
