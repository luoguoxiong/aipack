import { Client } from '@elastic/elasticsearch';
import { Application } from 'egg';

export const useElasticsearch = (app:Application) => {
  app.esClient = new Client(app.config.esClient);
};
