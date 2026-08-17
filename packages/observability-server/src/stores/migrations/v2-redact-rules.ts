/**
 * 迁移 v2：redact_rules 表（Phase 9 PII 脱敏规则）。
 *
 * 项目级脱敏规则存储，按 project_id 隔离；
 * 与 agent_definitions 类似，外键关联 projects（ON DELETE CASCADE）。
 */

import type { Migration } from '../mysql';

export const V2_REDACT_RULES: Migration = {
  version: 2,
  name: 'redact_rules',
  sql: `
    CREATE TABLE IF NOT EXISTS redact_rules (
      id          CHAR(26)     NOT NULL,
      project_id  CHAR(26)     NOT NULL,
      name        VARCHAR(100) NOT NULL,
      pattern     TEXT         NOT NULL,
      action      ENUM('mask','hash','drop') NOT NULL DEFAULT 'mask',
      enabled     TINYINT(1)   NOT NULL DEFAULT 1,
      created_at  BIGINT       NOT NULL,
      updated_at  BIGINT       NOT NULL,
      PRIMARY KEY (id),
      INDEX idx_redact_project (project_id),
      CONSTRAINT fk_rr_proj FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `,
};
