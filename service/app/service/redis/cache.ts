import { Service } from 'egg';

class RedisCacheService extends Service {
  async getTableIsCreate(tableNmae:string) {
    return await this.app.redis.hget('tableIsCreate', tableNmae) === '1';
  }
  async setTableIsCreate(tableName:string) {
    await this.app.redis.hset('tableIsCreate', tableName, '1');
  }
  async getAppIsUse(appId:string) {
    return await this.app.redis.hget('apps', appId) === '1';
  }
  async updateAppStatus(appId:string, isUse:boolean) {
    await this.app.redis.hset('apps', appId, isUse ? '1' : '0');
  }
}

export default RedisCacheService;
