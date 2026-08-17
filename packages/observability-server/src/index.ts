/**
 * @aipack-ai/observability-server — aipack 可观测性收集服务。
 *
 * 接收各应用 SDK（@aipack-ai/observability）的埋点上报，统一完成：
 *   - SQLite 落盘（runs / spans / tool_calls，事务批量）
 *   - 内存聚合（滑动窗口 + 在线直方图，p50/p95/p99）
 *   - REST 查询 API（/metrics/*、/traces/*）
 * 上报鉴权：appId + appSecret（OBS_APPS 白名单）。
 *
 * 作为库使用：import { createCollector, createCollectorServer } from '@aipack-ai/observability-server'
 */

export { createCollector, createCollectorServer } from './collector';
export type {
  Collector,
  CollectorOptions,
  RetentionOptions,
  AlertOptions,
  TlsOptions,
  AuthOptions,
  AgentOptions,
} from './collector';
export { Aggregator } from './aggregator';
export type { AggregatorOptions } from './aggregator';
export { SQLiteStore } from './store';
export type {
  AlertRuleRow,
  AlertEventRow,
  AlertStore,
  RunQueryFilter,
  RunListItem,
  TraceDetail,
  TraceStore,
} from './store';
export { createApiHandler } from './server';
export type { ApiHandler, ApiDeps } from './server';
export { createAdminHandler } from './admin';
export type { AdminDeps, AdminHandler } from './admin';
export { SessionManager, readBearerToken } from './auth';
export type { AdminCredentials } from './auth';

// Phase 4：多用户 RBAC（JWT access/refresh + Cookie）
export { JwtSessionManager } from './auth/jwt';
export type {
  AccessPayload,
  RefreshPayload,
  VerifiedUser,
  JwtSessionOptions,
} from './auth/jwt';
export { readAccessToken, readRefreshToken, readCookie, ACCESS_COOKIE, REFRESH_COOKIE } from './auth/jwt';
export { authenticate, requireRole, writeAuthFailure } from './middleware/auth';
export type {
  AuthContext,
  AuthResult,
  AuthFailure,
} from './middleware/auth';
export { createUsersHandler } from './api/users';
export type { UsersHandler, UsersApiDeps } from './api/users';
export { createProjectsHandler } from './api/projects';
export type { ProjectsHandler, ProjectsApiDeps } from './api/projects';
export { createAuthHandler } from './api/auth';
export type { AuthHandler, AuthApiDeps } from './api/auth';

// Phase 5：Agent 定义生命周期 + webhook
export { createAgentDefinitionsHandler } from './api/agent-definitions';
export type {
  AgentDefinitionsHandler,
  AgentDefinitionsApiDeps,
  AgentWebhook,
  AgentPublishedEvent,
} from './api/agent-definitions';
export { createAgentWebhook } from './agent-definition/webhook';
export type { WebhookOptions } from './agent-definition/webhook';
export { validateAgentName, validateAgentSpec } from './agent-definition/schema';

// Phase 1: 业务库 Store（用户/项目/Agent定义/ACL）+ MySQL 适配
// Phase 2: 监控库 Store（ClickHouse / Dual）+ TraceStore 异步接口
export { hashPassword, verifyPassword, isScryptHash } from './auth/password';
export {
  createBusinessStores,
  createTraceStore,
  SQLiteAppStore,
  MySQLAppStore,
  SQLiteUserStore,
  MySQLUserStore,
  SQLiteProjectStore,
  MySQLProjectStore,
  SQLiteAgentDefinitionStore,
  MySQLAgentDefinitionStore,
  SQLiteAclStore,
  MySQLAclStore,
  SQLiteModelPriceStore,
  MySQLModelPriceStore,
  SQLiteRedactRuleStore,
  MySQLRedactRuleStore,
  MysqlPool,
  runMigrations,
  ALL_MIGRATIONS,
  ulid,
  ClickHouseStore,
  ClickHouseClient,
  DualTraceStore,
} from './stores';
export type {
  BusinessStores,
  CreateBusinessStoresOptions,
  CreateTraceStoreOptions,
  AppStore,
  AppRecord,
  UserStore,
  UserRecord,
  UserWithCredentials,
  CreateUserInput,
  ProjectStore,
  ProjectRecord,
  CreateProjectInput,
  AgentDefinitionStore,
  AgentDefinitionRecord,
  AgentDefinitionStatus,
  AgentSpec,
  CreateAgentDefinitionInput,
  UpdateAgentDefinitionInput,
  AclStore,
  AclRecord,
  ProjectRole,
  GrantAclInput,
  ModelPriceStore,
  ModelPrice,
  UpsertModelPriceInput,
  RedactRuleStore,
  RedactRuleRecord,
} from './stores';
export type {
  BusinessStoreConfig,
  TraceStoreConfig,
  MqConfig,
  AggregatorRuntimeConfig,
  AuthConfig,
  AgentConfig,
} from './config';
// Phase 7: 分布式聚合（memory / redis / hybrid）
export {
  createAggregatorFactory,
  RedisClient,
  RedisAggregator,
  HybridAggregator,
} from './aggregator/index';
export type {
  Aggregator as IAggregator,
  AggregatorFactory,
  AggregatorConfig,
  CreateAggregatorFactoryOptions,
  AggregatorFactoryHandle,
} from './aggregator/index';
// Phase 3: MQ 层（Kafka producer/consumer）+ 独立 worker
export {
  createMqProducer,
  NoopMqProducer,
  KafkaMqProducer,
  KafkaMqConsumer,
} from './mq';
export type {
  MqProducer,
  MqConsumer,
  MqMessage,
  MqProduceOptions,
  MqConsumerOptions,
  MqConsumeHandler,
  IngestMessage,
  DlqMessage,
  CreateMqProducerOptions,
  KafkaProducerOptions,
  KafkaConsumerOptions,
} from './mq';
export { sendToDlq, DlqMonitor } from './worker/dlq';
export { createAlertEvaluator } from './alerts/evaluator';
export type { AlertEvaluator, EvaluatorDeps } from './alerts/evaluator';
export { createNotifier } from './alerts/notify';
export type { Notifier, NotifierOptions, AlertNotification } from './alerts/notify';
export {
  ALERT_METRICS,
  ALERT_OPERATORS,
  validateRule,
  compare,
  ALERT_METRIC_LABELS,
  ALERT_OPERATOR_LABELS,
  DEFAULT_LOOKBACK_MS,
  DEFAULT_COOLDOWN_MS,
} from './alerts/rules';
export type {
  AlertMetric,
  AlertOperator,
  AlertRule,
  NewAlertRule,
  ValidateResult,
} from './alerts/rules';
export type {
  AggregatedMetrics,
  GroupBy,
  SummaryFilter,
  TimeseriesMetric,
  TimeseriesPoint,
  ToolStat,
  VersionMetrics,
  VersionToolStat,
} from './types';

// Phase 3：Redis 限流（多实例水平扩展）
export { RedisRateLimiter, createRedisRateLimiter } from './rate-limit-redis';

// Phase 6：Cost 核算
export { createCostCalculator } from './cost/calculator';
export type { CostCalculator, ModelPrice as CostModelPrice } from './cost/calculator';

// Phase 8：冷归档（Parquet → S3）
export { exportToParquet } from './archive/parquet-writer';
export type { ParquetExportOptions, ParquetExportResult } from './archive/parquet-writer';
export { createArchiveScheduler } from './archive/scheduler';
export type { ArchiveScheduler, ArchiveSchedulerOptions } from './archive/scheduler';
