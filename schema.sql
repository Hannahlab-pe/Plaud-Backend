-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Crear la base de datos (ejecuta esto en pgAdmin conectado a postgres)
-- ─────────────────────────────────────────────────────────────────────────────
-- CREATE DATABASE plaud_db;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Conectate a plaud_db y ejecuta el resto
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS recordings (
  id                   SERIAL PRIMARY KEY,

  -- Identificacion de la grabacion
  recording_id         VARCHAR(255) NOT NULL,
  team_member_name     VARCHAR(255) NOT NULL,        -- nombre del miembro del equipo
  team_member_email    VARCHAR(255) NOT NULL,        -- email (identifica la cuenta Plaud)
  device_serial        VARCHAR(255),                 -- numero de serie del dispositivo Plaud

  -- Datos de la grabacion
  filename             VARCHAR(500),
  duration_seconds     INTEGER,
  recorded_at          TIMESTAMPTZ,                  -- cuando se hizo la grabacion
  keywords             JSONB DEFAULT '[]',           -- palabras clave detectadas por IA

  -- Contenido
  transcript           TEXT,                         -- transcripcion completa
  summary              TEXT,                         -- resumen generado por IA

  -- Meta
  raw_payload          JSONB,                        -- datos crudos de la API (para debug)
  received_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Una grabacion por cuenta (si el mismo usuario la tiene en dos cuentas, se guarda dos veces)
  UNIQUE (recording_id, team_member_email)
);

-- Tabla de miembros registrados (tokens guardados en DB)
CREATE TABLE IF NOT EXISTS team_members (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  email      VARCHAR(255),
  token      TEXT NOT NULL,
  region     VARCHAR(10) NOT NULL DEFAULT 'us',
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (token)
);

-- Indices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_rec_member_email  ON recordings(team_member_email);
CREATE INDEX IF NOT EXISTS idx_rec_recorded_at   ON recordings(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_rec_member_date   ON recordings(team_member_email, recorded_at DESC);

-- Vista util: resumen por miembro
CREATE OR REPLACE VIEW team_summary AS
SELECT
  team_member_name,
  team_member_email,
  COUNT(*)                                    AS total_recordings,
  ROUND(SUM(duration_seconds) / 60.0, 1)     AS total_minutes,
  MAX(recorded_at)                            AS last_recording,
  COUNT(*) FILTER (WHERE summary IS NOT NULL) AS with_summary
FROM recordings
GROUP BY team_member_name, team_member_email
ORDER BY total_recordings DESC;
