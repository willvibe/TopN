-- ============================================================
--  TopN 评分系统数据库表结构
--  数据库: TopN   字符集: utf8mb4
-- ============================================================

CREATE DATABASE IF NOT EXISTS `TopN`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE `TopN`;

-- ---------- 大赛表 ----------
CREATE TABLE IF NOT EXISTS competitions (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  name_subtitle VARCHAR(200) DEFAULT '',   -- 副标题(第二行, 可选), 显示时字体略小
  description   TEXT,
  status        ENUM('draft','published','live','ended') NOT NULL DEFAULT 'draft',
  active_work_id INT DEFAULT NULL,                  -- 当前路演中的作品 (大屏推进)
  share_token   VARCHAR(64) UNIQUE,    -- 评委扫码总入口 (旧, 兼容保留)
  screen_token  VARCHAR(64) UNIQUE,    -- 大屏实时数据入口
  expert_token  VARCHAR(64) UNIQUE,    -- 专家评委注册链接
  senior_token  VARCHAR(64) UNIQUE,    -- 资深评委注册链接
  normal_token  VARCHAR(64) UNIQUE,    -- 普通评委注册链接
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- (active_work_id -> works.id 的外键在所有表创建后通过 ALTER 添加, 见文件末尾)

-- ---------- 作品表 ----------
CREATE TABLE IF NOT EXISTS works (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  competition_id INT NOT NULL,
  seq            INT NOT NULL DEFAULT 0,        -- 路演顺序
  name           VARCHAR(200) NOT NULL,
  team           VARCHAR(200) DEFAULT '',
  category       VARCHAR(100) DEFAULT '',
  description    TEXT,
  access_url     VARCHAR(500) DEFAULT '',       -- 项目访问地址(部署好的 web 应用 URL)
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_works_comp FOREIGN KEY (competition_id)
    REFERENCES competitions(id) ON DELETE CASCADE,
  INDEX idx_works_comp (competition_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 评分标准表（带权重） ----------
CREATE TABLE IF NOT EXISTS standards (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  competition_id INT NOT NULL,
  seq            INT NOT NULL DEFAULT 0,
  name           VARCHAR(200) NOT NULL,
  description    TEXT,
  weight         INT NOT NULL DEFAULT 0,        -- 百分比 0-100
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_std_comp FOREIGN KEY (competition_id)
    REFERENCES competitions(id) ON DELETE CASCADE,
  INDEX idx_std_comp (competition_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 评委表 ----------
CREATE TABLE IF NOT EXISTS judges (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  competition_id INT NOT NULL,
  seq            INT NOT NULL DEFAULT 0,
  name           VARCHAR(200) NOT NULL,
  seat_no        VARCHAR(50) DEFAULT '',        -- 席位号, 如 A08
  level          ENUM('expert','senior','normal') NOT NULL DEFAULT 'normal', -- 专家/资深/普通
  weight         DECIMAL(3,2) NOT NULL DEFAULT 1.00,        -- 个人评分权重: 专家1.5 资深1.2 普通1.0
  access_token   VARCHAR(64) NOT NULL UNIQUE,   -- 评委专属评分链接
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_judge_comp FOREIGN KEY (competition_id)
    REFERENCES competitions(id) ON DELETE CASCADE,
  INDEX idx_judge_comp (competition_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 评分明细表 ----------
--   每行 = 某评委 对 某作品 的 某一维度 的一次评分
--   (work_id, judge_id, standard_id) 唯一, 同一组用 UPSERT 覆盖
CREATE TABLE IF NOT EXISTS scores (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  competition_id INT NOT NULL,
  work_id        INT NOT NULL,
  judge_id       INT NOT NULL,
  standard_id    INT NOT NULL,
  score          DECIMAL(5,2) NOT NULL,         -- 0.00 - 10.00
  round          TINYINT NOT NULL DEFAULT 1,    -- 1=首次, 2=修改
  attempt        TINYINT NOT NULL DEFAULT 0,    -- 该评委对该作品的提交次数 (0/1/2)
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_score (work_id, judge_id, standard_id),
  CONSTRAINT fk_score_work  FOREIGN KEY (work_id)     REFERENCES works(id)     ON DELETE CASCADE,
  CONSTRAINT fk_score_judge FOREIGN KEY (judge_id)    REFERENCES judges(id)    ON DELETE CASCADE,
  CONSTRAINT fk_score_std   FOREIGN KEY (standard_id) REFERENCES standards(id) ON DELETE CASCADE,
  INDEX idx_score_comp (competition_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 延迟添加 competitions.active_work_id 外键 ----------
-- (因为 competitions 在 works 之前创建, 故外键放在最后)
SET @fk_exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'competitions'
  AND CONSTRAINT_NAME = 'fk_comp_active');
SET @sql = IF(@fk_exists = 0,
  'ALTER TABLE competitions ADD CONSTRAINT fk_comp_active FOREIGN KEY (active_work_id) REFERENCES works(id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
