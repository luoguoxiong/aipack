/**
 * 迁移 v1：初始 schema（users / projects / project_apps / apps /
 * agent_definitions / acl / model_prices / schema_migrations）。
 *
 * 与 infra/mysql/init.sql 内容一致（Docker 首次启动用 init.sql，
 * 应用层连已有 MySQL 实例时用此迁移自动建表）。
 */

import type { Migration } from '../mysql';
import { V2_REDACT_RULES } from './v2-redact-rules';

export const V1_INITIAL_SCHEMA: Migration = {
  version: 1,
  name: 'initial_schema',
  sql: `
    CREATE TABLE IF NOT EXISTS users (
      id            CHAR(26)     NOT NULL,
      email         VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name          VARCHAR(100),
      created_at    BIGINT       NOT NULL,
      PRIMARY KEY (id),
      UNIQUE INDEX uk_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4

    CREATE TABLE IF NOT EXISTS projects (
      id          CHAR(26)     NOT NULL,
      name        VARCHAR(100) NOT NULL,
      owner_id    CHAR(26)     NOT NULL,
      created_at  BIGINT       NOT NULL,
      PRIMARY KEY (id),
      INDEX idx_owner (owner_id),
      CONSTRAINT fk_proj_owner FOREIGN KEY (owner_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4

    CREATE TABLE IF NOT EXISTS project_apps (
      project_id CHAR(26)    NOT NULL,
      app_id     VARCHAR(64) NOT NULL,
      PRIMARY KEY (project_id, app_id),
      INDEX idx_app (app_id),
      CONSTRAINT fk_pa_proj FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4

    CREATE TABLE IF NOT EXISTS apps (
      app_id       VARCHAR(128) NOT NULL,
      app_secret   VARCHAR(128) NOT NULL,
      name         VARCHAR(100) NOT NULL,
      created_at   BIGINT       NOT NULL,
      last_seen_at BIGINT,
      PRIMARY KEY (app_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4

    CREATE TABLE IF NOT EXISTS agent_definitions (
      id           CHAR(26)     NOT NULL,
      project_id   CHAR(26)     NOT NULL,
      name         VARCHAR(100) NOT NULL,
      version      INT          NOT NULL,
      status       ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
      spec         JSON         NOT NULL,
      created_by   CHAR(26)     NOT NULL,
      created_at   BIGINT       NOT NULL,
      published_at BIGINT,
      PRIMARY KEY (id),
      UNIQUE KEY uk_name_version (project_id, name, version),
      INDEX idx_project_status (project_id, status),
      CONSTRAINT fk_ad_proj FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_ad_user FOREIGN KEY (created_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4

    CREATE TABLE IF NOT EXISTS acl (
      user_id    CHAR(26) NOT NULL,
      project_id CHAR(26) NOT NULL,
      role       ENUM('owner','editor','viewer') NOT NULL,
      granted_at BIGINT   NOT NULL,
      granted_by CHAR(26),
      PRIMARY KEY (user_id, project_id),
      CONSTRAINT fk_acl_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_acl_proj FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4

    CREATE TABLE IF NOT EXISTS model_prices (
      model_id           VARCHAR(100)  NOT NULL,
      input_per_1m       DECIMAL(10,4) NOT NULL,
      output_per_1m      DECIMAL(10,4) NOT NULL,
      cache_read_per_1m  DECIMAL(10,4) NOT NULL DEFAULT 0,
      cache_write_per_1m DECIMAL(10,4) NOT NULL DEFAULT 0,
      currency           CHAR(3)       NOT NULL DEFAULT 'USD',
      effective_at       BIGINT        NOT NULL,
      PRIMARY KEY (model_id, effective_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `,
};

export const ALL_MIGRATIONS: Migration[] = [V1_INITIAL_SCHEMA, V2_REDACT_RULES];
