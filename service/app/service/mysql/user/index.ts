import { Service } from 'egg';
import * as sequelize from 'sequelize';
import { UserModelIn, UserModel } from './type';

export default class AppMysqlService extends Service {
  private async getModel():Promise<sequelize.ModelCtor<sequelize.Model<UserModelIn>>> {
    const tableName = 'user';
    const model = this.app.model.define(tableName, UserModel);
    const isExist = await this.service.redis.cache.getTableIsCreate(tableName);
    if (!isExist) {
      await model.sync();
      await this.service.redis.cache.setTableIsCreate(tableName);
    }
    return model;
  }

  async createUser(data:Omit<UserModelIn, 'status' | 'id'>) {
    try {
      const model = await this.getModel();
      await model.create({
        ...data,
        status: 1,
      });
    } catch (error) {
      throw error;
    }
  }

  async findUser(data:Partial<UserModelIn>) {
    try {
      const model = await this.getModel();
      const result = await model.findOne({
        where: {
          ...data,
        },
      });
      return result?.toJSON() as UserModelIn;
    } catch (error) {
      throw error;
    }
  }
}
