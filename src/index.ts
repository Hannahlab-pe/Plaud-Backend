import express from "express";
import dotenv from "dotenv";
import { pool, testConnection } from "./db";
import { syncAllMembers, loadAllTeamMembers } from "./sync";
import { PlaudClient } from "./plaud-client";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MINUTES ?? 30) * 60 * 1000;

app.use(express.json());

// CORS — permite el frontend en Railway y localhost para desarrollo
const ALLOWED_ORIGINS = [
  "https://plaud-frontend-production.up.railway.app",
  "http://localhost:5173",
  "http://localhost:4173",
];

app.use((req, res, next) => {
  const origin = req.headers.origin ?? "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Miembros ─────────────────────────────────────────────────────────────────

// Listar miembros registrados en DB
app.get("/members", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email, region, active, created_at FROM team_members ORDER BY created_at ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Registrar nuevo miembro con su token de Plaud
app.post("/members", async (req, res) => {
  const { name, token, region } = req.body as { name?: string; token?: string; region?: string };

  if (!name?.trim() || !token?.trim()) {
    res.status(400).json({ error: "name y token son requeridos" });
    return;
  }

  // Validar que el token funciona antes de guardarlo
  try {
    const client = new PlaudClient(token.trim(), null, region === "eu" ? "eu" : "us");
    const userInfo = await client.getUserInfo();

    const result = await pool.query(
      `INSERT INTO team_members (name, email, token, region)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, active = true
       RETURNING id, name, email, region, created_at`,
      [name.trim(), userInfo.email, token.trim(), region === "eu" ? "eu" : "us"]
    );

    console.log(`Nuevo miembro registrado: ${name} (${userInfo.email})`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: `Token invalido o no se pudo conectar con Plaud: ${String(err)}` });
  }
});

// Desactivar miembro
app.delete("/members/:id", async (req, res) => {
  try {
    await pool.query("UPDATE team_members SET active = false WHERE id = $1", [req.params["id"]]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Sync ─────────────────────────────────────────────────────────────────────

app.post("/sync", async (_req, res) => {
  try {
    const members = await loadAllTeamMembers();
    if (members.length === 0) {
      res.status(400).json({ error: "No hay miembros configurados" });
      return;
    }
    const results = await syncAllMembers(members);
    res.json({ ok: true, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// ─── Grabaciones ──────────────────────────────────────────────────────────────

app.get("/recordings", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
    const offset = Number(req.query["offset"] ?? 0);
    const member = req.query["member"] as string | undefined;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (member) {
      params.push(member);
      conditions.push(`team_member_email = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    const result = await pool.query(
      `SELECT id, recording_id, team_member_name, team_member_email,
              device_serial, filename, duration_seconds, recorded_at,
              keywords, summary, received_at
       FROM recordings
       ${where}
       ORDER BY recorded_at DESC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ total: result.rowCount, recordings: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al consultar grabaciones" });
  }
});

app.get("/recordings/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM recordings WHERE recording_id = $1 ORDER BY received_at DESC LIMIT 1",
      [req.params["id"]]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Grabacion no encontrada" });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al consultar grabacion" });
  }
});

app.get("/recordings/:id/audio-url", async (req, res) => {
  try {
    const row = await pool.query(
      "SELECT team_member_email FROM recordings WHERE recording_id = $1 LIMIT 1",
      [req.params["id"]]
    );
    if (row.rows.length === 0) {
      res.status(404).json({ error: "Grabacion no encontrada" });
      return;
    }

    const email: string = row.rows[0]["team_member_email"];
    const members = await loadAllTeamMembers();
    const member = members.find((m) => m.email === email || m.name === email);
    if (!member) {
      res.status(404).json({ error: "Miembro no encontrado" });
      return;
    }

    const client = member.token
      ? new PlaudClient(member.token, null, member.region)
      : new PlaudClient(member.email, member.password!, member.region);

    const url = await client.getMp3Url(req.params["id"]);
    if (!url) {
      res.status(404).json({ error: "URL de audio no disponible" });
      return;
    }

    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Regenerar resumen con skill/template opcional
app.post("/recordings/:id/regenerate-summary", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT transcript FROM recordings WHERE recording_id = $1 LIMIT 1",
      [req.params["id"]]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Grabacion no encontrada" });
      return;
    }
    const transcript: string = result.rows[0]["transcript"];
    if (!transcript?.trim()) {
      res.status(400).json({ error: "Esta grabacion no tiene transcripcion guardada" });
      return;
    }

    // Obtener prompt del skill si se especifica
    let skillPrompt: string | undefined;
    const skillId = req.body?.skill_id;
    if (skillId) {
      const skillResult = await pool.query("SELECT prompt FROM skills WHERE id = $1", [skillId]);
      if (skillResult.rows.length > 0) {
        skillPrompt = skillResult.rows[0]["prompt"] as string;
      }
    }

    const { summarize } = await import("./processor");
    const summary = await summarize(transcript, skillPrompt);

    await pool.query(
      "UPDATE recordings SET summary = $1 WHERE recording_id = $2",
      [summary, req.params["id"]]
    );

    res.json({ ok: true, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// ─── Skills / Templates ───────────────────────────────────────────────────────

app.get("/skills", async (_req, res) => {
  try {
    const result = await pool.query("SELECT * FROM skills ORDER BY is_default DESC, created_at ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/skills", async (req, res) => {
  const { name, description, prompt } = req.body as { name?: string; description?: string; prompt?: string };
  if (!name?.trim() || !prompt?.trim()) {
    res.status(400).json({ error: "name y prompt son requeridos" });
    return;
  }
  try {
    const result = await pool.query(
      "INSERT INTO skills (name, description, prompt) VALUES ($1, $2, $3) RETURNING *",
      [name.trim(), description?.trim() ?? null, prompt.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.put("/skills/:id", async (req, res) => {
  const { name, description, prompt } = req.body as { name?: string; description?: string; prompt?: string };
  if (!name?.trim() || !prompt?.trim()) {
    res.status(400).json({ error: "name y prompt son requeridos" });
    return;
  }
  try {
    const result = await pool.query(
      "UPDATE skills SET name=$1, description=$2, prompt=$3 WHERE id=$4 AND is_default=false RETURNING *",
      [name.trim(), description?.trim() ?? null, prompt.trim(), req.params["id"]]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Skill no encontrado o es un template por defecto" });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.delete("/skills/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM skills WHERE id=$1 AND is_default=false", [req.params["id"]]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Estadisticas ─────────────────────────────────────────────────────────────

app.get("/stats", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         team_member_name,
         team_member_email,
         COUNT(*) AS total_recordings,
         SUM(duration_seconds) AS total_seconds,
         MAX(recorded_at) AS last_recording,
         COUNT(*) FILTER (WHERE summary IS NOT NULL AND summary != '') AS with_summary
       FROM recordings
       GROUP BY team_member_name, team_member_email
       ORDER BY total_recordings DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al consultar estadisticas" });
  }
});

// ─── Sync automatico ──────────────────────────────────────────────────────────

async function startAutoSync() {
  const members = await loadAllTeamMembers();
  if (members.length === 0) {
    console.log("Sin miembros configurados — sync automatico desactivado");
    return;
  }

  console.log(`Sync automatico cada ${SYNC_INTERVAL_MS / 60000} min para ${members.length} miembro(s)`);
  syncAllMembers(members).catch(console.error);

  setInterval(async () => {
    const all = await loadAllTeamMembers();
    syncAllMembers(all).catch(console.error);
  }, SYNC_INTERVAL_MS);
}

// ─── Arranque ─────────────────────────────────────────────────────────────────

async function main() {
  try {
    await testConnection();
    console.log("Conexion a PostgreSQL exitosa");
  } catch (err) {
    console.error("No se pudo conectar a PostgreSQL:", err);
    process.exit(1);
  }

  // Crear tablas si no existen
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recordings (
      id                   SERIAL PRIMARY KEY,
      recording_id         VARCHAR(255) NOT NULL,
      team_member_name     VARCHAR(255) NOT NULL,
      team_member_email    VARCHAR(255) NOT NULL,
      device_serial        VARCHAR(255),
      filename             VARCHAR(500),
      duration_seconds     INTEGER,
      recorded_at          TIMESTAMPTZ,
      keywords             JSONB DEFAULT '[]',
      transcript           TEXT,
      summary              TEXT,
      raw_payload          JSONB,
      received_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (recording_id, team_member_email)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rec_member_email ON recordings(team_member_email)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rec_recorded_at  ON recordings(recorded_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS skills (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      description VARCHAR(500),
      prompt      TEXT NOT NULL,
      is_default  BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Skills de ejemplo si la tabla esta vacia
  const skillCount = await pool.query("SELECT COUNT(*) FROM skills");
  if (Number(skillCount.rows[0]["count"]) === 0) {
    await pool.query(`
      INSERT INTO skills (name, description, prompt, is_default) VALUES
      ('General', 'Resumen balanceado para cualquier reunion', 'Eres un analista de negocios experto. Resume la reunion de forma clara y estructurada, destacando decisiones, acuerdos y proximos pasos.', true),
      ('Direccion', 'Enfocado en decisiones estrategicas y KPIs', 'Eres un asesor de alta direccion. Resume enfocandote exclusivamente en decisiones estrategicas, impacto economico, riesgos del negocio y compromisos de liderazgo. Omite detalles operativos menores.'),
      ('Ventas', 'Seguimiento de oportunidades y clientes', 'Eres un especialista en ventas B2B. Resume destacando: estado de la oportunidad, objeciones del cliente, compromisos del equipo comercial, proximos pasos y probabilidad de cierre.'),
      ('Tecnico', 'Decisiones de arquitectura y desarrollo', 'Eres un tech lead senior. Resume enfocandote en decisiones tecnicas, deuda tecnica identificada, dependencias criticas, riesgos de implementacion y tareas asignadas al equipo de desarrollo.')
    `);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_members (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(255) NOT NULL,
      email      VARCHAR(255),
      token      TEXT NOT NULL,
      region     VARCHAR(10) NOT NULL DEFAULT 'us',
      active     BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (token)
    )
  `);

  app.listen(PORT, () => {
    console.log(`\nServidor en http://localhost:${PORT}`);
    console.log(`POST /members         — registrar miembro`);
    console.log(`GET  /members         — listar miembros`);
    console.log(`POST /sync            — sincronizar ahora`);
    console.log(`GET  /recordings      — listar grabaciones`);
    console.log(`GET  /recordings/:id  — detalle + transcripcion`);
    console.log(`GET  /stats           — estadisticas`);
  });

  startAutoSync();
}

main();
