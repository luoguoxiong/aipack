import { Controller } from 'egg';
import { getCookieMessge } from '@/app/utils/getCookieMessge';
import { generateShortUUID } from '@/app/utils';
export default class ReportController extends Controller {
  async getAppList() {
    try {
      const userId = await getCookieMessge(this.ctx);
      if (userId) {
        const data = await this.service.mysql.app.index.getList(userId);
        this.ctx.success(data);
      }
    } catch (error) {
      this.app.logger.error(error);
    }
  }

  async createApp() {
    try {
      const { appType, appName } = this.ctx.request.body;
      const userId = await getCookieMessge(this.ctx);
      if (userId) {
        const appId = generateShortUUID();
        await this.service.mysql.app.index.createApp({
          appId,
          status: 1,
          createId: userId,
          appType,
          appName,
        });
        await this.service.mysql.traffics.index.createTrafficTable(appId);
        await this.service.elasticsearch.pages.createIndex(appId);
        await this.service.redis.cache.updateAppStatus(appId, true);
        this.ctx.success();
      }
    } catch (error) {
      this.app.logger.error(error);
    }
  }

  async updateAppStatus() {
    try {
      const { id, status, appId } = this.ctx.request.body;
      const userId = await getCookieMessge(this.ctx);
      if (userId) {
        await this.service.mysql.app.index.updateAppStatus(id, status);
        await this.service.redis.cache.updateAppStatus(appId, status === 1);
        this.ctx.success();
      }
    } catch (error) {
      this.app.logger.error(error);
    }
  }
}
