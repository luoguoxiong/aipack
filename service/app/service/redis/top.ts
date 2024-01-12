import { Service } from 'egg';

type TopKeys = 'webVisit' | 'browser' | 'deviceVendor' | 'city' | 'osName';

interface TopRes {
  label:string,
  value:string | number
}

class RedisTopService extends Service {
  private getKeyName = (appId:string, type:TopKeys) => `${appId}-top-${type}`;

  /**
   * 获取指定应用程序的排行榜数据
   * @param appId - 应用程序ID
   * @param {TopKeys} type - 排行榜类型
   * @param top - 获取前N名的数据
   * @return {Promise<TopRes[]>} - 指定排行榜类型的前N名数据，以TopRes数组的形式返回
   */
  public async getTopData(appId:string, type:TopKeys, top?:number):Promise<TopRes[]> {
    const members = await this.app.redis.zrevrange(this.getKeyName(appId, type), 0, top ? top - 1 : -1);
    const tasks = members.map(member => {
      return this.app.redis.zscore(this.getKeyName(appId, type), member);
    });
    const data = await Promise.all(tasks);
    return data.map((item, index) => {
      return {
        label: members[index],
        value: item || 0,
      };
    });
  }

  /**
   * 设置指定应用程序的排行榜数据
   * @param appId - 应用程序ID
   * @param {TopKeys} type - 排行榜类型
   * @param member - 成员名称
   */
  public async setTopData(appId:string, type:TopKeys, member:string) {
    await this.app.redis.zincrby(this.getKeyName(appId, type), 1, member);
  }
}

export default RedisTopService;
