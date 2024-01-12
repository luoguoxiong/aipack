// This file is created by egg-ts-helper@1.35.1
// Do not modify this file!!!!!!!!!
/* eslint-disable */

import 'egg';
type AnyClass = new (...args: any[]) => any;
type AnyFunc<T = any> = (...args: any[]) => T;
type CanExportFunc = AnyFunc<Promise<any>> | AnyFunc<IterableIterator<any>>;
type AutoInstanceType<T, U = T extends CanExportFunc ? T : T extends AnyFunc ? ReturnType<T> : T> = U extends AnyClass ? InstanceType<U> : U;
import ExportElasticsearchIndex from '../../../app/service/elasticsearch/index';
import ExportElasticsearchPages from '../../../app/service/elasticsearch/pages';
import ExportElasticsearchTrafficStats from '../../../app/service/elasticsearch/trafficStats';
import ExportElasticsearchType from '../../../app/service/elasticsearch/type';
import ExportKafukaIndex from '../../../app/service/kafuka/index';
import ExportKafukaReport from '../../../app/service/kafuka/report';
import ExportKafukaType from '../../../app/service/kafuka/type';
import ExportRedisCache from '../../../app/service/redis/cache';
import ExportRedisDayNewUsers from '../../../app/service/redis/dayNewUsers';
import ExportRedisEveryDayActiveUsers from '../../../app/service/redis/everyDayActiveUsers';
import ExportRedisEveryDayIps from '../../../app/service/redis/everyDayIps';
import ExportRedisEveryDayPv from '../../../app/service/redis/everyDayPv';
import ExportRedisTop from '../../../app/service/redis/top';
import ExportMysqlAppIndex from '../../../app/service/mysql/app/index';
import ExportMysqlAppType from '../../../app/service/mysql/app/type';
import ExportMysqlTrafficsIndex from '../../../app/service/mysql/traffics/index';
import ExportMysqlTrafficsType from '../../../app/service/mysql/traffics/type';
import ExportMysqlUserIndex from '../../../app/service/mysql/user/index';
import ExportMysqlUserType from '../../../app/service/mysql/user/type';

declare module 'egg' {
  interface IService {
    elasticsearch: {
      index: AutoInstanceType<typeof ExportElasticsearchIndex>;
      pages: AutoInstanceType<typeof ExportElasticsearchPages>;
      trafficStats: AutoInstanceType<typeof ExportElasticsearchTrafficStats>;
      type: AutoInstanceType<typeof ExportElasticsearchType>;
    }
    kafuka: {
      index: AutoInstanceType<typeof ExportKafukaIndex>;
      report: AutoInstanceType<typeof ExportKafukaReport>;
      type: AutoInstanceType<typeof ExportKafukaType>;
    }
    redis: {
      cache: AutoInstanceType<typeof ExportRedisCache>;
      dayNewUsers: AutoInstanceType<typeof ExportRedisDayNewUsers>;
      everyDayActiveUsers: AutoInstanceType<typeof ExportRedisEveryDayActiveUsers>;
      everyDayIps: AutoInstanceType<typeof ExportRedisEveryDayIps>;
      everyDayPv: AutoInstanceType<typeof ExportRedisEveryDayPv>;
      top: AutoInstanceType<typeof ExportRedisTop>;
    }
    mysql: {
      app: {
        index: AutoInstanceType<typeof ExportMysqlAppIndex>;
        type: AutoInstanceType<typeof ExportMysqlAppType>;
      }
      traffics: {
        index: AutoInstanceType<typeof ExportMysqlTrafficsIndex>;
        type: AutoInstanceType<typeof ExportMysqlTrafficsType>;
      }
      user: {
        index: AutoInstanceType<typeof ExportMysqlUserIndex>;
        type: AutoInstanceType<typeof ExportMysqlUserType>;
      }
    }
  }
}
