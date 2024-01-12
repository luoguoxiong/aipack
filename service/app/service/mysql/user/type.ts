import * as sequelize from 'sequelize';
export interface UserModelIn {
  /** 用户ID */
  id?:number
  /** 登录账号 */
  account:string
  /** 加密登录密码 */
  encPassword:string
  /** 账号状态 */
  status: 0 | 1
  createdAt?: string
  updatedAt?:string
}

export const UserModel:sequelize.ModelAttributes = {
  id: { type: sequelize.INTEGER, primaryKey: true, autoIncrement: true },
  account: {
    type: sequelize.STRING,
    allowNull: false,
    unique: true,
    comment: '登录账号',
  },
  encPassword: {
    type: sequelize.STRING,
    allowNull: false,
    comment: '加密登录密码',
  },
  status: {
    type: sequelize.INTEGER(),
    defaultValue: 1,
    comment: '账号状态',
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
