import { pool } from "./db";
import { PlaudClient } from "./plaud-client";
import { processAudio } from "./processor";

const USE_WHISPER = !!process.env.OPENAI_API_KEY;
const USE_CLAUDE  = !!process.env.ANTHROPIC_API_KEY;

export interface TeamMember {
  name: string;
  email: string;
  password: string | null;  // null cuando se usa token directo
  token: string | null;     // token de localStorage (Google/Apple login)
  region: "us" | "eu";
}

interface SyncResult {
  member: string;
  new_recordings: number;
  errors: string[];
}

// Sincroniza todas las grabaciones de un miembro del equipo
async function syncMember(member: TeamMember): Promise<SyncResult> {
  const result: SyncResult = { member: member.name, new_recordings: 0, errors: [] };
  // Modo token directo (Google/Apple) o email+password
  const client = member.token
    ? new PlaudClient(member.token, null, member.region)
    : new PlaudClient(member.email, member.password!, member.region);

  let recordings;
  try {
    recordings = await client.listRecordings();
  } catch (err) {
    result.errors.push(`Login fallido para ${member.email}: ${String(err)}`);
    return result;
  }

  // Sincronizar todas las grabaciones (con o sin transcripcion)
  const pending = recordings;

  for (const rec of pending) {
    // Saltar solo si ya existe con transcript y summary completos
    const exists = await pool.query(
      "SELECT 1 FROM recordings WHERE recording_id = $1 AND team_member_email = $2 AND transcript IS NOT NULL AND transcript != '' AND summary IS NOT NULL AND summary != ''",
      [rec.id, member.email]
    );
    if (exists.rowCount && exists.rowCount > 0) continue;

    try {
      const detail = await client.getRecordingDetail(rec.id);

      let transcript = detail.transcript;
      let summary = detail.summary ?? "";

      if (USE_WHISPER) {
        const mp3Url = await client.getMp3Url(rec.id);
        if (mp3Url) {
          const mode = USE_CLAUDE ? "Whisper + Claude" : "Whisper + GPT-4o";
          console.log(`  [${member.name}] Procesando con ${mode}: ${detail.filename}`);
          const processed = await processAudio(mp3Url, detail.filename);
          transcript = processed.transcript || transcript;
          summary = processed.summary || summary;
        } else {
          console.log(`  [${member.name}] Sin URL de audio, usando datos de Plaud`);
        }
      }

      await pool.query(
        `INSERT INTO recordings
          (recording_id, team_member_name, team_member_email, device_serial,
           filename, duration_seconds, recorded_at, keywords,
           transcript, summary, raw_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (recording_id, team_member_email) DO UPDATE SET
           transcript   = CASE WHEN EXCLUDED.transcript != '' THEN EXCLUDED.transcript ELSE recordings.transcript END,
           summary      = CASE WHEN EXCLUDED.summary    != '' THEN EXCLUDED.summary    ELSE recordings.summary    END,
           filename     = EXCLUDED.filename,
           raw_payload  = EXCLUDED.raw_payload`,
        [
          detail.id,
          member.name,
          member.email,
          detail.serial_number || null,
          detail.filename,
          detail.duration,
          detail.start_time ? new Date(detail.start_time) : null,
          JSON.stringify(detail.keywords),
          transcript,
          summary,
          JSON.stringify(detail),
        ]
      );

      result.new_recordings++;
      const mode = USE_WHISPER && USE_CLAUDE ? "Whisper+Claude" : USE_WHISPER ? "Whisper" : "Plaud";
      console.log(`  [${member.name}] Guardada (${mode}): ${detail.filename}`);
    } catch (err) {
      result.errors.push(`Error en grabacion ${rec.id}: ${String(err)}`);
    }
  }

  return result;
}

// Sincroniza todos los miembros del equipo
export async function syncAllMembers(members: TeamMember[]): Promise<SyncResult[]> {
  console.log(`\nIniciando sync para ${members.length} miembro(s)...`);
  const results: SyncResult[] = [];

  for (const member of members) {
    console.log(`\nSincronizando: ${member.name} (${member.email})`);
    const r = await syncMember(member);
    results.push(r);
    if (r.errors.length > 0) {
      r.errors.forEach((e) => console.warn(`  WARN: ${e}`));
    }
    console.log(`  Nuevas grabaciones: ${r.new_recordings}`);
  }

  return results;
}

// Carga los miembros del equipo desde la base de datos
export async function loadTeamFromDB(): Promise<TeamMember[]> {
  const result = await pool.query(
    "SELECT name, email, token, region FROM team_members WHERE active = true ORDER BY created_at ASC"
  );
  return result.rows.map((r) => ({
    name: String(r["name"]),
    email: String(r["email"] ?? r["name"]),
    password: null,
    token: String(r["token"]),
    region: r["region"] === "eu" ? "eu" : "us",
  }));
}

// Carga desde DB y desde .env, sin duplicados por token
export async function loadAllTeamMembers(): Promise<TeamMember[]> {
  const fromEnv = loadTeamFromEnv();
  const fromDB = await loadTeamFromDB();
  const seen = new Set(fromDB.map((m) => m.token));
  const merged = [...fromDB];
  for (const m of fromEnv) {
    if (m.token && !seen.has(m.token)) merged.push(m);
  }
  return merged;
}

// Carga los miembros del equipo desde variables de entorno
//
// Formato con password:      nombre:email:password:region
// Formato con token directo: nombre:TOKEN:eyJ...:region
//
// Ejemplo:
// TEAM_MEMBERS=Jair:TOKEN:eyJhbGciOiJIUzI1NiJ9...:us
export function loadTeamFromEnv(): TeamMember[] {
  const raw = process.env.TEAM_MEMBERS ?? "";
  if (!raw.trim()) return [];

  return raw.split(",").map((entry) => {
    const parts = entry.trim().split(":");
    const [name, emailOrTokenKey] = parts;
    const value = parts.slice(2, parts.length - 1).join(":"); // el token puede contener ":"
    const region = parts[parts.length - 1] as "us" | "eu";

    if (!name || !emailOrTokenKey || !value) {
      throw new Error(`TEAM_MEMBERS mal formateado: "${entry}"`);
    }

    // Si el segundo campo es "TOKEN", el tercero es el token directo
    if (emailOrTokenKey === "TOKEN") {
      return {
        name,
        email: name,
        password: null,
        token: value,
        region: region === "eu" ? "eu" : "us",
      };
    }

    return {
      name,
      email: emailOrTokenKey,
      password: value,
      token: null,
      region: region === "eu" ? "eu" : "us",
    };
  });
}
