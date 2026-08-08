-- =====================================================================
-- LOTOCE QUANT INTELLIGENCE PLATFORM — SCHEMA (FASE 1)
-- =====================================================================
-- Banco único. As três sessões (MANHÃ/TARDE/NOITE) são uma dimensão
-- do sorteio, não tabelas separadas (regra da seção 6 do prompt).
-- =====================================================================

CREATE TABLE IF NOT EXISTS sessions_config (
  id              SERIAL PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,        -- ex: 'MANHA', 'TARDE', 'NOITE'
  label           TEXT NOT NULL,                -- ex: 'Manhã'
  sort_order      SMALLINT NOT NULL,            -- ordem lógica (1=manhã,2=tarde,3=noite)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Aliases para variações encontradas nos arquivos (ex: "Tarde II" -> mapeado
-- manualmente pelo usuário para uma sessão oficial, ou registrado como nova).
-- Nenhum valor não mapeado é convertido silenciosamente (regra da seção 7).
CREATE TABLE IF NOT EXISTS session_aliases (
  id              SERIAL PRIMARY KEY,
  raw_value       TEXT NOT NULL,                -- valor exato encontrado no arquivo, ex: 'Tarde II'
  session_id      INTEGER REFERENCES sessions_config(id),
  decision        TEXT NOT NULL,                -- 'MAPPED' | 'NEW_SESSION' | 'IGNORED'
  decided_by      TEXT,                          -- quem decidiu (usuário/sistema)
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(raw_value)
);

CREATE TABLE IF NOT EXISTS draws (
  id                  BIGSERIAL PRIMARY KEY,
  draw_date           DATE NOT NULL,
  session_id          INTEGER NOT NULL REFERENCES sessions_config(id),
  contest_number      TEXT,                       -- se disponível na fonte
  draw_time           TIME,                        -- horário oficial, se disponível
  is_time_official    BOOLEAN NOT NULL DEFAULT false,
  event_datetime      TIMESTAMPTZ NOT NULL,        -- usado para ordenação/cutoff
  temporal_source     TEXT NOT NULL,               -- 'OFFICIAL_SOURCE' | 'FILE_TIMESTAMP' | 'LOGICAL_SESSION_ORDER'
  source              TEXT NOT NULL,               -- 'EXCEL_IMPORT' | 'MANUAL_PASTE'
  import_job_id        BIGINT,
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(draw_date, session_id, contest_number)
);

CREATE TABLE IF NOT EXISTS draw_results (
  id          BIGSERIAL PRIMARY KEY,
  draw_id     BIGINT NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
  position    SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 10),
  number      CHAR(4) NOT NULL CHECK (number ~ '^[0-9]{4}$'),  -- sempre com zero à esquerda
  UNIQUE(draw_id, position)
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id                BIGSERIAL PRIMARY KEY,
  kind              TEXT NOT NULL,                -- 'EXCEL' | 'MANUAL_PASTE'
  original_filename TEXT,
  status            TEXT NOT NULL DEFAULT 'PENDING_CONFIRMATION', -- PENDING_CONFIRMATION | CONFIRMED | REJECTED
  raw_payload       TEXT,                          -- texto colado ou referência ao arquivo
  records_found     INTEGER DEFAULT 0,
  records_valid     INTEGER DEFAULT 0,
  records_invalid   INTEGER DEFAULT 0,
  duplicates_found  INTEGER DEFAULT 0,
  errors_json       JSONB,                         -- detalhe linha/campo/valor/motivo
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_events (
  id            BIGSERIAL PRIMARY KEY,
  event_type    TEXT NOT NULL,     -- IMPORT | CORRECTION | SESSION_ALIAS_DECISION | ...
  payload_json  JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tabelas das fases futuras (schema reservado, ainda não usadas nas Fases 1-3)
CREATE TABLE IF NOT EXISTS models (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL,
  parameters_json JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(name, version)
);
CREATE TABLE IF NOT EXISTS backtest_runs (
  id BIGSERIAL PRIMARY KEY, model_id INTEGER REFERENCES models(id),
  started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, params_json JSONB, results_json JSONB
);
CREATE TABLE IF NOT EXISTS prediction_runs (
  id BIGSERIAL PRIMARY KEY, model_id INTEGER REFERENCES models(id),
  target_event_datetime TIMESTAMPTZ NOT NULL, cutoff_datetime TIMESTAMPTZ NOT NULL,
  last_data_datetime TIMESTAMPTZ, dataset_hash TEXT, model_hash TEXT,
  parameters_json JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cutoff_datetime < target_event_datetime)
);
CREATE TABLE IF NOT EXISTS frozen_prediction_items (
  id BIGSERIAL PRIMARY KEY, prediction_run_id BIGINT REFERENCES prediction_runs(id),
  number CHAR(4) NOT NULL, score NUMERIC, rank INTEGER
);
CREATE TABLE IF NOT EXISTS prediction_results (
  id BIGSERIAL PRIMARY KEY, prediction_run_id BIGINT REFERENCES prediction_runs(id),
  draw_id BIGINT REFERENCES draws(id), evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metrics_json JSONB
);

-- Sessões oficiais padrão (seed inicial — o usuário pode adicionar mais depois)
INSERT INTO sessions_config (code, label, sort_order) VALUES
  ('MANHA', 'Manhã', 1), ('TARDE', 'Tarde', 2), ('NOITE', 'Noite', 3)
ON CONFLICT (code) DO NOTHING;
