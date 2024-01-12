import { EggAppConfig, PowerPartial } from 'egg';

export default () => {
  const config: PowerPartial<EggAppConfig> = {};
  config.sequelize = {
    datasources: [
      {
        dialect: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        database: 'database_development',
        password: '123456',
        define: {
          freezeTableName: true,
          timestamps: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    ],
  };

  config.kafka = {
    kafkaHost: 'localhost:9092',
  };

  config.esClient = {
    node: 'http://localhost:9200',
  };

  config.redis = {
    client: {
      port: 6379,
      host: '127.0.0.1',
      password: 'auth',
      db: 0,
    },
  };

  return config;
};
