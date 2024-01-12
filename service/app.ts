import { Application } from 'egg';
import { useKafka } from '@/app/service/kafuka';
import { useElasticsearch } from '@/app/service/elasticsearch';
export default function(app: Application) {
  const ctx = app.createAnonymousContext();
  app.beforeStart(async () => {
    useKafka(app);
    useElasticsearch(app);
    ctx.service.kafuka.report.useKafkaConsume();
  });
}
