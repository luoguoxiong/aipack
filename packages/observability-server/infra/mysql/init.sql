-- aipack 业务库初始化 (MySQL 8.0+)
-- 由 docker-entrypoint-initdb.d 在首次启动 mysql 容器时执行。
-- 后续 schema 变更走 src/stores/migrations/ 编号化迁移(Phase 1 实现)。

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ── users ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            CHAR(26)    NOT NULL,                       -- ULID
  email         VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,                      -- argon2id
  name          VARCHAR(100),
  created_at    BIGINT      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uk_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── projects ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id          CHAR(26)    NOT NULL,
  name        VARCHAR(100) NOT NULL,
  owner_id    CHAR(26)    NOT NULL,
  created_at  BIGINT      NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_owner (owner_id),
  CONSTRAINT fk_proj_owner FOREIGN KEY (owner_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── project_apps (项目 ↔ app 多对多) ──────────────────────────
CREATE TABLE IF NOT EXISTS project_apps (
  project_id CHAR(26)    NOT NULL,
  app_id     VARCHAR(64) NOT NULL,
  PRIMARY KEY (project_id, app_id),
  INDEX idx_app (app_id),
  CONSTRAINT fk_pa_proj FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── apps (从 SQLite 迁移,字段对齐) ────────────────────────────
CREATE TABLE IF NOT EXISTS apps (
  app_id       VARCHAR(64)  NOT NULL,
  app_secret   VARCHAR(128) NOT NULL,
  name         VARCHAR(100) NOT NULL,
  created_at   BIGINT       NOT NULL,
  last_seen_at BIGINT,
  PRIMARY KEY (app_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── agent_definitions (版本化) ────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_definitions (
  id           CHAR(26)    NOT NULL,
  project_id   CHAR(26)    NOT NULL,
  name         VARCHAR(100) NOT NULL,
  version      INT         NOT NULL,                  -- 同 project+name 内自增
  status       ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  spec         JSON        NOT NULL,                  -- { systemPrompt, tools, model, params }
  created_by   CHAR(26)    NOT NULL,
  created_at   BIGINT      NOT NULL,
  published_at BIGINT,
  PRIMARY KEY (id),
  UNIQUE KEY uk_name_version (project_id, name, version),
  INDEX idx_project_status (project_id, status),
  CONSTRAINT fk_ad_proj FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_ad_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── acl (项目成员授权) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS acl (
  user_id    CHAR(26) NOT NULL,
  project_id CHAR(26) NOT NULL,
  role       ENUM('owner','editor','viewer') NOT NULL,
  granted_at BIGINT   NOT NULL,
  granted_by CHAR(26),
  PRIMARY KEY (user_id, project_id),
  CONSTRAINT fk_acl_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_acl_proj FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── model_prices (Phase 6 Cost 核算) ──────────────────────────
CREATE TABLE IF NOT EXISTS model_prices (
  model_id           VARCHAR(100) NOT NULL,
  input_per_1m       DECIMAL(10,4) NOT NULL,         -- $/1M tokens
  output_per_1m      DECIMAL(10,4) NOT NULL,
  cache_read_per_1m  DECIMAL(10,4) NOT NULL DEFAULT 0,
  cache_write_per_1m DECIMAL(10,4) NOT NULL DEFAULT 0,
  currency           CHAR(3)       NOT NULL DEFAULT 'USD',
  effective_at       BIGINT        NOT NULL,
  PRIMARY KEY (model_id, effective_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── schema_migrations (迁移版本号) ────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INT         NOT NULL,
  name        VARCHAR(200) NOT NULL,
  applied_at  BIGINT      NOT NULL,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 种入初始迁移记录(init.sql 即 migration v1)
INSERT IGNORE INTO schema_migrations (version, name, applied_at) VALUES
  (1, 'initial_schema', UNIX_TIMESTAMP() * 1000);

SET FOREIGN_KEY_CHECKS = 1;
