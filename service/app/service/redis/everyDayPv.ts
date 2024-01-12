import dayjs from 'dayjs';
import { Service } from 'egg';

class RedisPvService extends Service {
  private getKeyName = (appId:string, dateString:string) => `${appId}-pv-${dateString}`;

  async addPv(appId:string) {
    await this.app.redis.incr(this.getKeyName(appId, dayjs().format('YYYY-MM-DD')));
  }

  async getPv(appId:string, dateString:string) {
    return await this.app.redis.get(this.getKeyName(appId, dateString)) || 0;
  }
}

export default RedisPvService;
