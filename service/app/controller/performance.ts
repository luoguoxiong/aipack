import { Controller } from 'egg';

export default class PerformanceController extends Controller {
  public async getPagesPerformance() {
    const { ctx, service } = this;
    const data = await service.elasticsearch.pages.analyzeAppTrafficStats(ctx.query.appId, 1703502000000, new Date().getTime(), 'userId');
    const data2 = await service.elasticsearch.pages.analyzePageTrafficStats(ctx.query.appId, 1703502000000, new Date().getTime(), 'userId');
    this.ctx.success({
      data,
      data2,
      datas: data2.reduce((prev, cur) => {
        return prev + cur.count;
      }, 0) });
  }
}
