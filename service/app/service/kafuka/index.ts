import assert from 'node:assert';
import kafka, { KafkaClient, Producer, KafkaClientOptions, ProduceRequest, Message } from 'kafka-node';
import { Application } from 'egg';
import { Topics } from './type';
export class Kafka {
  private config:KafkaClientOptions;
  private app: Application;
  private client: KafkaClient;
  private producer: Producer;
  private isInit:boolean;

  constructor(config:KafkaClientOptions, app:Application) {
    this.config = config;
    this.app = app;
    this.client = new kafka.KafkaClient(this.config);
    const Producer = kafka.Producer;
    this.producer = new Producer(this.client);
    this.producer.on('ready', () => {
      this.isInit = true;
      this.app.coreLogger.info('[kafka] the producer is ready.');
    });
    this.producer.on('error', err => {
      this.app.coreLogger.error(`[kafka] have error ${err}`);
    });
  }

  consumer(topic:Topics, onMessage:(messge:Message)=>void) {
    this.client.createTopics([{
      topic,
      partitions: 1,
      replicationFactor: 1,
    }], err => {
      if (err) {
        console.log('forEach', err);
        return;
      }
      const offsetFetchRequest = {
        topic,
      };
      const consumer = new kafka.Consumer(
        this.client,
        [ offsetFetchRequest ],
        {
          autoCommit: true,
        },
      );
      consumer.on('error', err => {
        this.app.coreLogger.error(`[kafka] consumer have error ${err}`);
      });
      consumer.on('message', (message:Message) => {
        onMessage && onMessage(message);
      });
    });
  }

  send(topic:Topics, messages:any) {
    if (this.isInit) {
      const message:ProduceRequest = {
        topic,
        messages: JSON.stringify(messages),
      };
      this.producer.send([ message ], err => {
        if (err) assert(err, '[kafka] producer send err. errmsg ${err}');
      });
    } else {
      this.app.coreLogger.error('[kafka] producer is no ready!');
    }
  }
}

export const useKafka = (app:Application) => {
  app.kafka = new Kafka(app.config.kafka, app);
};
