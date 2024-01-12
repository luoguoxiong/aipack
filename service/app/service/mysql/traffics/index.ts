import { Service } from 'egg';
import * as sequelize from 'sequelize';
import { TrafficModel, TrafficModelIn } from './type';
import { createIndexName } from '@/app/utils';

export default class TrafficMysqlService extends Service {

  private getMysqlTableName = (appId:string) => createIndexName(this.app.config.appIndexName.page_traffics, appId);

  private async getModel(appId:string):Promise<sequelize.ModelCtor<sequelize.Model<TrafficModelIn>>> {
    const tableName = this.getMysqlTableName(appId);
    const model = this.app.model.define(tableName, TrafficModel, {
      indexes: [
        {
          unique: true,
          fields: [ 'statisticsTime', 'pageUrl', 'appId', 'type' ],
          name: 'unique_combination', // 可选的索引名称
        },
      ],
    });
    return model;
  }

  async createTrafficTable(appId:string) {
    const tableName = this.getMysqlTableName(appId);
    const model = this.app.model.define(tableName, TrafficModel, {
      indexes: [
        {
          unique: true,
          fields: [ 'statisticsTime', 'pageUrl', 'appId', 'type' ],
          name: 'unique_combination', // 可选的索引名称
        },
      ],
    });
    await model.sync();
  }

  async insertData(data:TrafficModelIn) {
    const model = await this.getModel(data.appId);
    await model.create({
      ...data,
    });
  }

  async getTrafficData(appId:string, { beginTime, endTime, type, pageUrl }) {
    const model = await this.getModel(appId);
    return await model.findAll({
      where: {
        appId,
        type,
        pageUrl,
        statisticsTime: {
          [sequelize.Op.between]: [ beginTime, endTime ],
        },
      },
    });
  }
}
