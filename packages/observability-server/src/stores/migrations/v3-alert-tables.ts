/**
 * 迁移 v3：告警表（alert_rules / alert_events）。
 *
 * 告警存储与业务库共用 MySQL 连接池；时间戳统一为 BIGINT（epoch ms）。
 */

import type { Migration } from '../mysql';

export const V3_ALERT_TABLES: Migration = {
  version: 3,
  name: 'alert_tables',
  sql: `
    CREATE TABLE IF NOT EXISTS alert_rules (
      id          VARCHAR(64)  NOT NULL,
      name        VARCHAR(200) NOT NULL,
      app_id      VARCHAR(128),
      metric      VARCHAR(64)  NOT NULL,
      operator    VARCHAR(16)  NOT NULL,
      threshold   DOUBLE       NOT NULL,
      lookback_ms BIGINT       NOT NULL,
      cooldown_ms BIGINT       NOT NULL,
      webhook_url VARCHAR(500),
      tool_name   VARCHAR(128),
      error_class VARCHAR(200),
      enabled     TINYINT(1)   NOT NULL DEFAULT 1,
      created_at  BIGINT       NOT NULL,
      updated_at  BIGINT       NOT NULL,
      PRIMARY KEY (id),
      INDEX idx_alert_rules_app (app_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS alert_events (
      id          BIGINT       NOT NULL AUTO_INCREMENT,
      rule_id     VARCHAR(64)  NOT NULL,
      rule_name   VARCHAR(200) NOT NULL,
      app_id      VARCHAR(128),
      metric      VARCHAR(64)  NOT NULL,
      operator    VARCHAR(16)  NOT NULL,
      threshold   DOUBLE       NOT NULL,
      value       DOUBLE       NOT NULL,
      status      VARCHAR(16)  NOT NULL,
      created_at  BIGINT       NOT NULL,
      PRIMARY KEY (id),
      INDEX idx_alert_events_created (created_at),
      INDEX idx_alert_events_rule (rule_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `,
};
