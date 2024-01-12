import { Service } from 'egg';
import parser from 'cron-parser';
import { TrafficStatsQuery, TrafficStatsTimeQuery, TrafficStatsIn, TrafficStatsRes, PageStats, PageStatsResult } from './type';

export default class TrafficStatsService extends Service {
  /**
   * 获取 Traffic 统计数据的方法，以分钟为单位
   */
  async getTrafficStatsMinutes() {
    try {
      const interval = parser.parseExpression(this.app.config.trafficStatsScheduleMin);
      const endTime = interval.prev().getTime();
      const beginTime = interval.prev().getTime();
      await this.getAllAppTrafficStats(
        {
          beginTime,
          endTime,
        },
        async (trafficStatsRes, appId) => {
          // 转换 Traffic 统计数据格式并存储到数据库
          const pageStatsResult = this.trafficTrasform(trafficStatsRes);
          for (let index = 0; index < pageStatsResult.length; index++) {
            const item = pageStatsResult[index];
            this.service.mysql.traffics.index.insertData({
              appId,
              type: 1,
              statisticsTime: new Date(endTime),
              ...item,
            });
          }
        },
        async (trafficStatsRes, appId) => {
          this.service.mysql.traffics.index.insertData({
            appId,
            type: 1,
            statisticsTime: new Date(endTime),
            ...trafficStatsRes,
          });
        },
      );
    } catch (error) {
      this.app.logger.error(error);
    }
  }

  async getTrafficStatsDays() {
    try {
      const interval = parser.parseExpression(this.app.config.trafficStatsScheduleDay);
      const endTime = new Date().getTime();
      const beginTime = interval.prev().getTime();
      this.getAllAppTrafficStats(
        {
          beginTime,
          endTime,
        },
        async (trafficStatsRes, appId) => {
          // 转换 Traffic 统计数据格式并存储到数据库
          const pageStatsResult = this.trafficTrasform(trafficStatsRes);
          for (let index = 0; index < pageStatsResult.length; index++) {
            const item = pageStatsResult[index];
            this.service.mysql.traffics.index.insertData({
              appId,
              type: 2,
              statisticsTime: new Date(endTime),
              ...item,
            });
          }
        },
        async (trafficStatsRes, appId) => {
          this.service.mysql.traffics.index.insertData({
            appId,
            type: 2,
            statisticsTime: new Date(endTime),
            ...trafficStatsRes,
          });
        },
      );
    } catch (error) {
      this.app.logger.error(error);
    }
  }

  /**
   * 统计页面 URL 数量的辅助方法
   * @param {TrafficIpStatsIn[] | TrafficUvStatsIn[]} data - Traffic 数据
   * @param {string} key - 要统计的关键字（'uniqueIPsCount' 或 'uniqueVisitors'）
   * @param {PageStats} pageStats - 页面统计结果对象
   * @return {PageStats} - 更新后的页面统计结果对象
   */
  private countPageUrls(data: TrafficStatsIn[], key: string, pageStats: PageStats): PageStats {
    data.forEach(item => {
      const { pageUrl } = item;
      if (pageStats[pageUrl]) {
        pageStats[pageUrl][key] = item.count;
      } else {
        pageStats[pageUrl] = {
          pageUrl,
          pageViews: 0,
          uniqueVisitors: 0,
          uniqueIPsCount: 0,
        };
        pageStats[pageUrl][key] = item.count;
      }
    });
    return pageStats;
  }

  /**
   * 将 Traffic 统计数据转换为前端展示格式
   * @param {TrafficStatsRes} trafficStatsRes - Traffic 统计数据
   * @return {PageStatsResult[]} - 转换后的页面统计结果数组
   */
  trafficTrasform = (trafficStatsRes: TrafficStatsRes): PageStatsResult[] => {
    const { trafficIpStats, trafficUvStats, trafficPvStats } = trafficStatsRes;
    const pageStats: PageStats = {};
    this.countPageUrls(trafficIpStats, 'uniqueIPsCount', pageStats);
    this.countPageUrls(trafficUvStats, 'uniqueVisitors', pageStats);
    this.countPageUrls(trafficPvStats, 'pageViews', pageStats);
    return Object.values(pageStats);
  };

  /**
   * 获取所有应用的 Traffic 统计数据
   * @param {TrafficStatsTimeQuery} query - 查询条件（开始时间和结束时间）
   * @param {Function} onOk - 获取成功时的回调函数
   */
  async getAllAppTrafficStats(query: TrafficStatsTimeQuery,
    onOnePageOk: (trafficStatsRes: TrafficStatsRes, appId: string) => void,
    onSuccess:(trafficStatsRes:PageStatsResult, appId: string) => void,
  ) {
    try {
      // 获取所有使用中的应用
      const apps = await this.service.mysql.app.index.getIsUseApps();
      if (!apps) return;
      await Promise.all(apps.map(async appId => {
        return this.getOnePageTrafficStats(
          {
            appId,
            ...query,
          },
          trafficStatsRes => {
            // 调用回调函数处理获取到的 Traffic 统计数据
            onOnePageOk(trafficStatsRes, appId);
          },
        );
      }));
      await Promise.all(apps.map(async appId => {
        return this.getTrafficStats(
          {
            appId,
            ...query,
          },
          trafficStatsRes => {
            // 调用回调函数处理获取到的 Traffic 统计数据
            onSuccess(trafficStatsRes, appId);
          },
        );
      }));
    } catch (error) {
      this.app.logger.error(error);
    }
  }

  async getTrafficStats(query: TrafficStatsQuery, onOk: (trafficStatsRes:PageStatsResult) => void) {
    try {
      // 并行获取 Traffic 统计数据中的 IP、UV 和 PV
      const [ pageViews, uniqueIPsCount, uniqueVisitors ] = await Promise.all([
        this.service.elasticsearch.pages.analyzeAppTrafficStats(query.appId, query.beginTime, query.endTime),
        this.service.elasticsearch.pages.analyzeAppTrafficStats(query.appId, query.beginTime, query.endTime, 'ip'),
        this.service.elasticsearch.pages.analyzeAppTrafficStats(query.appId, query.beginTime, query.endTime, 'markUserId'),
      ]);
      if (pageViews === 0 && uniqueIPsCount === 0 && uniqueVisitors === 0) {
        return;
      }
      // 调用回调函数处理获取到的 Traffic 统计数据
      onOk({
        pageUrl: '',
        pageViews,
        uniqueVisitors,
        uniqueIPsCount,
      });
    } catch (error) {
      this.app.logger.error(error);
    }
  }

  /**
   * 获取指定应用的 Traffic 统计数据
   * @param {TrafficStatsQuery} query - 查询条件（开始时间、结束时间和应用ID）
   * @param {Function} onOk - 获取成功时的回调函数
   */
  async getOnePageTrafficStats(query: TrafficStatsQuery, onOk: (trafficStatsRes: TrafficStatsRes) => void) {
    try {
      // 并行获取 Traffic 统计数据中的 IP、UV 和 PV
      const [ trafficIpStats, trafficUvStats, trafficPvStats ] = await Promise.all([
        this.getTrafficIpCount(query),
        this.getTrafficUvCount(query),
        this.getTrafficPvCount(query),
      ]);
      // 调用回调函数处理获取到的 Traffic 统计数据
      onOk({ trafficIpStats, trafficUvStats, trafficPvStats });
    } catch (error) {
      this.app.logger.error(error);
    }
  }

  /**
   * 获取指定应用在指定时间范围内的 IP 统计数据
   * @param {TrafficStatsQuery} query - 查询条件（应用ID、开始时间和结束时间）
   * @return {Promise<TrafficIpStatsIn[]>} - IP 统计数据数组
   */
  async getTrafficIpCount({ appId, beginTime, endTime }: TrafficStatsQuery): Promise<TrafficStatsIn[]> {
    return await this.service.elasticsearch.pages.analyzePageTrafficStats(appId, beginTime, endTime, 'ip');
  }

  /**
   * 获取指定应用在指定时间范围内的 UV 统计数据
   * @param {TrafficStatsQuery} query - 查询条件（应用ID、开始时间和结束时间）
   * @return {Promise<TrafficUvStatsIn[]>} - UV 统计数据数组
   */
  async getTrafficUvCount({ appId, beginTime, endTime }: TrafficStatsQuery): Promise<TrafficStatsIn[]> {
    return await this.service.elasticsearch.pages.analyzePageTrafficStats(appId, beginTime, endTime, 'markUserId');
  }

  /**
   * 获取指定应用在指定时间范围内的 PV 统计数据
   * @param {TrafficStatsQuery} query - 查询条件（应用ID、开始时间和结束时间）
   * @return {Promise<TrafficPvStatsIn[]>} - PV 统计数据数组
   */
  async getTrafficPvCount({ appId, beginTime, endTime }: TrafficStatsQuery): Promise<TrafficStatsIn[]> {
    return await this.service.elasticsearch.pages.analyzePageTrafficStats(appId, beginTime, endTime);
  }
}
