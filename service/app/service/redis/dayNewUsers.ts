import { Service } from 'egg';
import dayjs from 'dayjs';
class RedisDayNewUsersService extends Service {
  private getKeyName = (appId:string, dateString:string) => `${appId}-dayNewUsers-${dateString}`;

  async analyseDayNewUsers(appId:string, userId:string) {
    const isHas = await this.app.redis.sismember(`${appId}-allUsers`, userId);
    if (!isHas) {
      const key = this.getKeyName(appId, dayjs().format('YYYY-MM-DD'));
      await this.app.redis.sadd(`${appId}-allUsers`, [ userId ]);
      await this.app.redis.incr(key);
    }
  }

  async getOneDayNewUsers(appId:string, dateString?:string) {
    return await this.app.redis.get(this.getKeyName(appId, dayjs(dateString).format('YYYY-MM-DD'))) || 0;
  }

  async getAllUsers(appId:string) {
    return await this.app.redis.scard(`${appId}-allUsers`);
  }
}

export default RedisDayNewUsersService;
