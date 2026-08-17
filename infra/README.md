# aipack observability-server 基础设施

本地一键拉起 observability-server 平台型部署所需的 5 个依赖服务:MySQL / ClickHouse / Kafka / Zookeeper / Redis。

## 快速开始

```bash
# 1. 复制环境变量(按需改密码)
cp infra/.env.example infra/.env

# 2. 启动全部服务
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d

# 3. 验证健康状态
docker compose -f infra/docker-compose.yml ps
# 期望:5 个容器(含 kafka-init)状态全为 healthy 或 exited(0)

# 4. 验证连通性
mysql -h 127.0.0.1 -P 3306 -u aipack -paipackpass -e "SHOW DATABASES;"
curl http://127.0.0.1:8123/ping
docker exec aipack-kafka kafka-topics --bootstrap-server localhost:9092 --list
redis-cli -h 127.0.0.1 -p 6379 -a aipackpass ping
```

## 服务清单

| 服务 | 镜像 | 宿主端口 | 容器端口 | 用途 |
|---|---|---|---|---|
| mysql | mysql:8.4 | 3306 | 3306 | 业务库:users/projects/agent_definitions/acl/apps/model_prices |
| clickhouse | clickhouse/clickhouse-server:24.8 | 8123 (HTTP) / 9000 (TCP) | 8123 / 9000 | 监控库:runs/spans/tool_calls/events/retry_attempts |
| zookeeper | confluentinc/cp-zookeeper:7.7.0 | - | 2181 | Kafka 协调 |
| kafka | confluentinc/cp-kafka:7.7.0 | 9094 | 9092 (INTERNAL) | 消息队列,topic: `aipack.ingest` / `aipack.ingest.dlq` |
| kafka-init | confluentinc/cp-kafka:7.7.0 | - | - | 一次性容器,创建 topic 后退出 |
| redis | redis:7.4-alpine | 6379 | 6379 | 共享聚合窗口 + 限流计数 |

## 端口冲突

默认端口都被占用时,改 `infra/.env`:
- `MYSQL_PORT=3307`
- `CLICKHOUSE_HTTP_PORT=8124` / `CLICKHOUSE_TCP_PORT=9001`
- `KAFKA_PORT=9095`
- `REDIS_PORT=6380`

## 停止与重置

```bash
# 停止(保留数据)
docker compose -f infra/docker-compose.yml down

# 停止并删除所有数据卷(完全重置)
docker compose -f infra/docker-compose.yml down -v

# 仅重置 ClickHouse(保留 MySQL)
docker volume rm infra_clickhouse_data
```

## Kafka topic 配置

`kafka-init` 容器在首次启动时自动创建:
- `aipack.ingest` — 6 分区(由 `KAFKA_INGEST_PARTITIONS` 控制),retention 7 天
- `aipack.ingest.dlq` — 1 分区,retention 30 天

手动创建/查看:
```bash
docker exec aipack-kafka kafka-topics --bootstrap-server localhost:9092 --list
docker exec aipack-kafka kafka-topics --bootstrap-server localhost:9092 --describe --topic aipack.ingest
```

## ClickHouse 调试

```bash
# HTTP 查询
curl 'http://127.0.0.1:8123/?query=SELECT+*+FROM+aipack.runs+LIMIT+5'

# native client
docker exec -it aipack-clickhouse clickhouse-client --user aipack --password aipackpass \
  --query "SELECT count() FROM aipack.runs"

# 看分区与 TTL
docker exec aipack-clickhouse clickhouse-client --user aipack --password aipackpass \
  --query "SHOW TABLES FROM aipack"
```

## MySQL 调试

```bash
mysql -h 127.0.0.1 -P 3306 -u aipack -paipackpass aipack
> SHOW TABLES;
> DESCRIBE agent_definitions;
> SELECT version, name FROM schema_migrations;
```

## Redis 调试

```bash
redis-cli -h 127.0.0.1 -p 6379 -a aipackpass
> KEYS *
> HGETALL aipack:agg:global:1   # 聚合器窗口桶(Phase 7 实现)
```

## 生产环境注意事项

1. **密码**:务必修改 `.env` 中所有默认密码(`rootpass` / `aipackpass`)
2. **端口暴露**:生产环境删除 `ports` 映射,改用 Docker network 或内网
3. **TLS**:MySQL/CH/Kafka/Redis 均需启用 TLS(本配置未含,生产需补)
4. **持久化**:数据卷默认 local driver,生产建议改用云盘或 NFS
5. **Kafka 集群**:单 broker 仅适合开发,生产至少 3 broker + replication-factor=3
6. **Redis 高可用**:单实例仅适合开发,生产用 Redis Sentinel 或 Cluster
7. **备份**:MySQL `mysqldump` / CH `BACKUP` 定期到对象存储
