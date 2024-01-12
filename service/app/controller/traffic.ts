import { Controller } from 'egg';
import { getCookieMessge } from '@/app/utils/getCookieMessge';
import dayjs from 'dayjs';
export default class TrafficController extends Controller {
  async getTrafficTimes() {
    try {
      const userId = await getCookieMessge(this.ctx);
      if (userId) {
        const { appId, date, pageUrl } = this.ctx.query;
        const beginTime = dayjs(dayjs(date).format('YYYY-MM-DD 00:00:00')).valueOf();
        const endTime = dayjs(dayjs(date).format('YYYY-MM-DD 23:59:59')).valueOf();
        const searchPage = pageUrl || '';
        const data = await this.service.mysql.traffics.index.getTrafficData(appId, {
          type: 1,
          pageUrl: searchPage,
          beginTime,
          endTime,
        });
        const pageViews:any = {};
        const uniqueIPsCount:any = {};
        const uniqueVisitors:any = {};
        const max = 24;
        let index = 0;
        while (index < max) {
          index++;
          const horus = index < 10 ? `0${index}:00` : `${index}:00`;
          pageViews[horus] = 0;
          uniqueIPsCount[horus] = 0;
          uniqueVisitors[horus] = 0;
        }
        data.forEach(item => {
          const lable = dayjs(item.getDataValue('statisticsTime')).format('HH:00');
          pageViews[lable] = item.getDataValue('pageViews');
          uniqueIPsCount[lable] = item.getDataValue('uniqueIPsCount');
          uniqueVisitors[lable] = item.getDataValue('uniqueVisitors');
        });
        this.ctx.success({ pageViews, uniqueVisitors, uniqueIPsCount });
      }
    } catch (error) {
      this.app.logger.error(error);
    }
  }
  async getTrafficDays() {
    try {
      const userId = await getCookieMessge(this.ctx);
      if (userId) {
        const { appId, beginTime, endTime, pageUrl } = this.ctx.query;
        const beginTimes = dayjs(dayjs(beginTime).format('YYYY-MM-DD 00:00:00')).valueOf();
        const endTimes = dayjs(dayjs(endTime).format('YYYY-MM-DD 23:59:59')).valueOf();
        const searchPage = pageUrl || '';
        const data = await this.service.mysql.traffics.index.getTrafficData(appId, {
          type: 2,
          pageUrl: searchPage,
          beginTime: beginTimes,
          endTime: endTimes,
        });
        const pageViews:any = {};
        const uniqueIPsCount:any = {};
        const uniqueVisitors:any = {};
        const max = endTimes;
        let index = beginTimes;
        while (index < max) {
          const dateStr = dayjs(index).format('YYYY-MM-DD');
          pageViews[dateStr] = 0;
          uniqueIPsCount[dateStr] = 0;
          uniqueVisitors[dateStr] = 0;
          index = dayjs(dayjs(index)).add(1, 'day').valueOf();
        }
        data.forEach(item => {
          const lable = dayjs(item.getDataValue('statisticsTime')).format('YYYY-MM-DD');
          pageViews[lable] = item.getDataValue('pageViews');
          uniqueIPsCount[lable] = item.getDataValue('uniqueIPsCount');
          uniqueVisitors[lable] = item.getDataValue('uniqueVisitors');
        });
        this.ctx.success({ pageViews, uniqueVisitors, uniqueIPsCount });
      }
    } catch (error) {
      this.app.logger.error(error);
    }
  }
}

