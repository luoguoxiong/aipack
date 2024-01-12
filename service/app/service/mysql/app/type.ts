import * as sequelize from 'sequelize';
export interface AppModelIn {
  id?:number,
  /** 应用AppId */
  appId:string
  /** 应用类型 */
  appName: string
  /** 应用类型 */
  appType: number
  /** 创建用户Id */
  createId:number
  /** app使用状态 */
  status: 0 | 1
  createdAt?: string
  updatedAt?:string
}

export const AppModel:sequelize.ModelAttributes = {
  id: { type: sequelize.INTEGER, primaryKey: true, autoIncrement: true },
  appId: {
    type: sequelize.STRING,
    allowNull: false,
    unique: true,
    comment: '应用AppId',
  },
  appName: {
    type: sequelize.STRING,
    allowNull: false,
    comment: '应用名称',
  },
  appType: {
    type: sequelize.INTEGER(),
    allowNull: false,
    comment: 'app类型',
  },
  createId: {
    type: sequelize.INTEGER,
    defaultValue: false,
    allowNull: false,
    comment: '创建人用户ID',
  },
  status: {
    type: sequelize.INTEGER(),
    allowNull: false,
    comment: 'app使用状态',
  },
  createdAt: {
    type: sequelize.DATE,
    comment: '创建日期',
  },
  updatedAt: {
    type: sequelize.DATE,
    comment: '更新日期',
  },
};
