import { Service } from 'egg';

import { createIndexName } from '@/app/utils';

export default class PagesEsService extends Service {

  private getEsIndexName = (appId:string) => createIndexName(this.app.config.appIndexName.page_report, appId);

  async createIndex(appId:string) {
    try {
      const { body } = await this.app.esClient.indices.create({
        index: this.getEsIndexName(appId),
        body: {
          mappings: {
            properties: {
              userId: { type: 'keyword' },
              markUserId: { type: 'keyword' },
              pageUrl: { type: 'keyword' },
              ip: { type: 'keyword' },
              appId: { type: 'keyword' },
              isFirst: { type: 'boolean' },
              origin: { type: 'keyword' },
              browserName: { type: 'keyword' },
              browserVersion: { type: 'keyword' },
              browserMajor: { type: 'keyword' },
              osName: { type: 'keyword' },
              osVersion: { type: 'keyword' },
              deviceVendor: { type: 'keyword' },
              deviceModel: { type: 'keyword' },
              ua: { type: 'keyword' },
              province: { type: 'keyword' },
              country: { type: 'keyword' },
              city: { type: 'keyword' },
              dnsTime: { type: 'integer' },
              tcpTime: { type: 'integer' },
              whiteTime: { type: 'integer' },
              fcp: { type: 'integer' },
              ttfb: { type: 'integer' },
              lcp: { type: 'integer' },
              fid: { type: 'integer' },
              '@timestamp': { type: 'date' },
            },
          },
          // 定义索引的设置 例如分片数、副本数等
          settings: {},
        },
      });
      return body;
    } catch (error) {
      throw error;
    }
  }

  async saveReportData(appId:string, reportData:any) {
    try {
      return await this.app.esClient.index({
        index: this.getEsIndexName(appId),
        op_type: 'create', // 创建自增Id
        body: {
          ...reportData,
          '@timestamp': new Date(),
        },
      });
    } catch (error) {
      this.app.logger.error(error);
    }
  }

  async getReportData(appId:string) {
    try {
      const { body: initialResponse } = await this.app.esClient.search({
        index: this.getEsIndexName(appId),
        // scroll: '1m', // 设置滚动时间
        body: {
          // from: 2, // 起始记录索引，从第一条记录开始
          aggs: {
            grouped_data: {
              terms: {
                field: 'pageUrl.keyword', // 第一个字段
                size: 2147483647,
              },
              aggs: {
                data: {
                  terms: {
                    field: 'userId.keyword', // 第一个字段
                    size: 2147483647,
                  },
                },
              },
            },
          },
          track_total_hits: true,
        },
      });
      return initialResponse;
    } catch (error) {
      this.app.logger.error(error);
    }
  }

  async analyzePageTrafficStats(appId:string, beginTime:number, endTime:number, groupKey?:string) {
    const esQuery = {
      index: this.getEsIndexName(appId),
      body: {
        size: 0,
        aggs: {
          grouped_data: {
            terms: {
              field: 'pageUrl', // 第一个字段
              size: 2147483647,
            },
            aggs: {},
          },
        },
        query: {
          range: {
            '@timestamp': {
              gte: new Date(beginTime),
              lte: new Date(endTime),
            },
          },
        },
        track_total_hits: true,
      },
    };
    if (groupKey) {
      esQuery.body.aggs.grouped_data.aggs = {
        data: {
          terms: {
            field: `${groupKey}`, // 第一个字段
            size: 2147483647,
          },
        },
      };
      const { body } = await this.app.esClient.search(esQuery);
      const data = body.aggregations.grouped_data.buckets;

      return data.map(item => {
        return {
          pageUrl: item.key,
          count: item.data.buckets.length,
        };
      });
    }
    const { body } = await this.app.esClient.search(esQuery);
    const data = body.aggregations.grouped_data.buckets;
    return data.map(item => {
      return {
        pageUrl: item.key,
        count: item.doc_count,
      };
    });
  }

  async analyzeAppTrafficStats(appId:string, beginTime:number, endTime:number, groupKey?:string) {
    const esQuery = {
      index: this.getEsIndexName(appId),
      body: {
        size: 0,
        aggs: {},
        query: {
          range: {
            '@timestamp': {
              gte: new Date(beginTime),
              lte: new Date(endTime),
            },
          },
        },
        track_total_hits: true,
      },
    };
    if (groupKey) {
      esQuery.body.aggs = {
        grouped_data: {
          terms: {
            field: `${groupKey}`,
            size: 2147483647,
          },
        },
      };
      const { body } = await this.app.esClient.search(esQuery);
      const data = body.aggregations.grouped_data.buckets;
      return data.length;
    }
    const { body } = await this.app.esClient.search(esQuery);
    return body.hits.total.value;
  }
}
