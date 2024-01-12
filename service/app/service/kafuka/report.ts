import { Service } from 'egg';
import { Topics } from '@/app/service/kafuka/type';
import { PageModelIn } from '@/app/service/elasticsearch/type';
export default class ReportService extends Service {
  async useKafkaConsume() {
    this.app.kafka.consumer(Topics.TopicWeb, async message => {
      const pageMsg = JSON.parse(message.value as string) as PageModelIn;
      this.ctx.service.elasticsearch.pages.saveReportData(pageMsg.appId, pageMsg);
      this.ctx.service.redis.everyDayPv.addPv(pageMsg.appId);
      this.ctx.service.redis.top.setTopData(pageMsg.appId, 'webVisit', pageMsg.pageUrl);
      if (pageMsg.isFirst) {
        this.ctx.service.redis.everyDayActiveUsers.addUsers(pageMsg.appId, `${pageMsg.markUserId}`);
        this.ctx.service.redis.everyDayIps.addIps(pageMsg.appId, `${pageMsg.ip}`);
        this.ctx.service.redis.dayNewUsers.analyseDayNewUsers(pageMsg.appId, `${pageMsg.markUserId}`);
        if (pageMsg.browserName) {
          this.ctx.service.redis.top.setTopData(pageMsg.appId, 'browser', pageMsg.browserName);
        }
        if (pageMsg.deviceVendor) {
          this.ctx.service.redis.top.setTopData(pageMsg.appId, 'deviceVendor', pageMsg.deviceVendor);
        }
        if (pageMsg.osName) {
          this.ctx.service.redis.top.setTopData(pageMsg.appId, 'osName', pageMsg.osName);
        }
        if (pageMsg.province) {
          this.ctx.service.redis.top.setTopData(pageMsg.appId, 'city', pageMsg.province);
        }
      }
    });
  }

  sendMessgeToKafka(message:any) {
    this.app.kafka.send(Topics.TopicWeb, message);
  }
}
