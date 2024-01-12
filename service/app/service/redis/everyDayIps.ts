import { Service } from 'egg';
import dayjs from 'dayjs';
class RedisDayActiveUsersService extends Service {
  private getKeyName = (appId:string, dateString:string) => `${appId}-ips-${dateString}`;

  async addIps(appId:string, ip:string) {
    await this.app.redis.pfadd(this.getKeyName(appId, dayjs().format('YYYY-MM-DD')), ip);
  }

  async getIps(appId:string, dateString?:string) {
    return await this.app.redis.pfcount(this.getKeyName(appId, dayjs(dateString).format('YYYY-MM-DD')));
  }
}

export default RedisDayActiveUsersService;
