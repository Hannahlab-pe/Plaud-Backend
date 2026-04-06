import https from "https";
import zlib from "zlib";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";

const gunzip = promisify(zlib.gunzip);

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface PlaudRecording {
  id: string;
  filename: string;
  duration: number;        // segundos
  start_time: number;      // epoch ms
  end_time: number;        // epoch ms
  is_trans: boolean;       // tiene transcripcion
  is_summary: boolean;     // tiene resumen
  keywords: string[];
  serial_number: string;   // numero de serie del dispositivo Plaud
}

export interface PlaudRecordingDetail extends PlaudRecording {
  transcript: string;
  summary: string | null;
}

export interface PlaudUserInfo {
  id: string;
  nickname: string;
  email: string;
  membership_type: string;
}

interface StoredToken {
  accessToken: string;
  issuedAt: number;   // epoch ms
  expiresAt: number;  // epoch ms
}

interface StoredConfig {
  email: string;
  region: "us" | "eu";
  token?: StoredToken;
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const API_HOSTS: Record<string, string> = {
  us: "api.plaud.ai",
  eu: "api-euc1.plaud.ai",
};

// Token dura ~300 dias; se renueva cuando quedan menos de 30 dias
const TOKEN_REFRESH_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Helpers HTTP ─────────────────────────────────────────────────────────────

function httpRequest(options: https.RequestOptions, body?: string): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, data: raw });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Descarga y descomprime el archivo .json.gz de transcripcion desde S3
async function fetchTranscriptFromS3(url: string): Promise<string> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const req = https.request({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", async () => {
        try {
          const buf = Buffer.concat(chunks);
          const decompressed = await gunzip(buf);
          const json = JSON.parse(decompressed.toString("utf-8")) as unknown;
          // El JSON puede ser array de segmentos o un objeto con segments
          const segments: { speaker?: string; text?: string; content?: string }[] =
            Array.isArray(json) ? json : ((json as Record<string, unknown>)["segments"] as typeof segments ?? []);
          const text = segments
            .map((s) => (s.speaker ? `[${s.speaker}] ${s.text ?? s.content ?? ""}` : (s.text ?? s.content ?? "")))
            .filter(Boolean)
            .join("\n");
          resolve(text || JSON.stringify(json).slice(0, 5000));
        } catch {
          resolve("");
        }
      });
    });
    req.on("error", () => resolve(""));
    req.end();
  });
}

// ─── PlaudClient ──────────────────────────────────────────────────────────────

export class PlaudClient {
  private configPath: string;
  private config: StoredConfig;
  private directToken: string | null = null;

  /**
   * Modo A — email + password (requiere contraseña en cuenta Plaud)
   * Modo B — token directo obtenido de localStorage en web.plaud.ai
   */
  constructor(
    emailOrToken: string,
    private password: string | null = null,
    region: "us" | "eu" = "us"
  ) {
    this.configPath = path.join(os.homedir(), ".plaud", "config.json");

    // Si no hay password, asumimos que emailOrToken ES el token directamente
    if (!password) {
      this.directToken = emailOrToken;
      this.config = { email: "token-auth", region };
    } else {
      this.config = this.loadConfig(emailOrToken, region);
    }
  }

  // ── Config en disco ──────────────────────────────────────────────────────

  private loadConfig(email: string, region: "us" | "eu"): StoredConfig {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (fs.existsSync(this.configPath)) {
        const saved = JSON.parse(fs.readFileSync(this.configPath, "utf-8")) as StoredConfig;
        // Si cambia el email, descarta token cacheado
        if (saved.email === email) return saved;
      }
    } catch { /* si falla lectura, empezamos de cero */ }
    return { email, region };
  }

  private saveConfig(): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    } catch (err) {
      console.warn("No se pudo guardar config de Plaud:", err);
    }
  }

  // ── Autenticacion ────────────────────────────────────────────────────────

  private async login(): Promise<string> {
    if (!this.password) throw new Error("No hay password configurado para este miembro");
    const host = API_HOSTS[this.config.region];
    const body = new URLSearchParams({
      username: this.config.email,
      password: this.password,
    }).toString();

    const { data } = await httpRequest({
      hostname: host,
      path: "/auth/access-token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, body);

    const res = data as { status: number; access_token?: string; msg?: string };
    if (res.status !== 0 || !res.access_token) {
      throw new Error(`Login fallido: ${res.msg ?? "respuesta inesperada"}`);
    }

    const now = Date.now();
    this.config.token = {
      accessToken: res.access_token,
      issuedAt: now,
      expiresAt: now + 300 * 24 * 60 * 60 * 1000,
    };
    this.saveConfig();
    return res.access_token;
  }

  async getToken(): Promise<string> {
    // Modo token directo (Google/Apple login)
    if (this.directToken) return this.directToken;

    const { token } = this.config;
    if (!token) return this.login();

    const needsRefresh = token.expiresAt - Date.now() < TOKEN_REFRESH_THRESHOLD_MS;
    if (needsRefresh) return this.login();

    return token.accessToken;
  }

  // ── API requests ─────────────────────────────────────────────────────────

  private async get<T>(endpoint: string): Promise<T> {
    const token = await this.getToken();
    const host = API_HOSTS[this.config.region];

    const { status, data } = await httpRequest({
      hostname: host,
      path: endpoint,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (status !== 200) throw new Error(`HTTP ${status} en ${endpoint}`);

    const res = data as { status: number; msg?: string; domains?: { api: string } } & T;

    // Auto-deteccion de region incorrecta
    if (res.status === -302 && res.domains?.api) {
      const newHost = res.domains.api;
      this.config.region = newHost.includes("euc1") ? "eu" : "us";
      this.saveConfig();
      return this.get<T>(endpoint);
    }

    if (res.status !== 0) throw new Error(`API error: ${res.msg ?? res.status}`);
    return res;
  }

  // ── Metodos publicos ─────────────────────────────────────────────────────

  async listRecordings(): Promise<PlaudRecording[]> {
    const data = await this.get<{ data_file_list: Record<string, unknown>[] }>("/file/simple/web");
    return (data.data_file_list ?? []).map((r) => ({
      id: String(r["id"] ?? ""),
      filename: String(r["filename"] ?? ""),
      duration: Number(r["duration"] ?? 0),
      start_time: Number(r["start_time"] ?? 0),
      end_time: Number(r["end_time"] ?? 0),
      is_trans: Boolean(r["is_trans"]),
      is_summary: Boolean(r["is_summary"]),
      keywords: Array.isArray(r["keywords"]) ? r["keywords"] as string[] : [],
      serial_number: String(r["serial_number"] ?? ""),
    }));
  }

  async getRecordingDetail(id: string): Promise<PlaudRecordingDetail> {
    const raw = await this.get<Record<string, unknown>>(`/file/detail/${id}`);
    const data: Record<string, unknown> = (raw["data"] ?? raw) as Record<string, unknown>;

    // Resumen: item en pre_download_content_list cuyo data_id empieza con "auto_sum:"
    const preDownloadList = Array.isArray(data["pre_download_content_list"])
      ? (data["pre_download_content_list"] as { data_id?: string; data_content?: string }[])
      : [];
    const summaryItem = preDownloadList.find((c) => String(c.data_id ?? "").startsWith("auto_sum:"));
    const summary = summaryItem?.data_content ?? null;

    // Transcripcion: URL en content_list donde data_type === "transaction"
    const apiContentList = Array.isArray(data["content_list"])
      ? (data["content_list"] as { data_type?: string; data_link?: string; task_status?: number }[])
      : [];
    const transcriptItem = apiContentList.find((c) => c.data_type === "transaction" && c.task_status === 1 && c.data_link);
    const transcript = transcriptItem?.data_link
      ? await fetchTranscriptFromS3(transcriptItem.data_link)
      : "";

    const durationSec = Number(data["duration"] ?? 0);
    const startTime = Number(data["start_time"] ?? 0);

    return {
      id: String(data["file_id"] ?? id),
      filename: String(data["file_name"] ?? ""),
      duration: durationSec,
      start_time: startTime,
      end_time: startTime + durationSec * 1000,
      is_trans: Boolean(transcript),
      is_summary: Boolean(summary),
      keywords: Array.isArray(data["keywords"]) ? data["keywords"] as string[] : [],
      serial_number: String(data["serial_number"] ?? ""),
      transcript,
      summary,
    };
  }

  async getUserInfo(): Promise<PlaudUserInfo> {
    const data = await this.get<Record<string, unknown>>("/user/me");
    const user = (data["data_user"] ?? data) as Record<string, unknown>;
    const state = data["data_state"] as Record<string, unknown> | undefined;
    return {
      id: String(user["id"] ?? ""),
      nickname: String(user["nickname"] ?? ""),
      email: String(user["email"] ?? this.config.email),
      membership_type: String(state?.["membership_type"] ?? "free"),
    };
  }

  async getMp3Url(id: string): Promise<string | null> {
    try {
      const data = await this.get<Record<string, unknown>>(`/file/temp-url/${id}?is_opus=false`);
      const nested = data["data"] as Record<string, unknown> | undefined;
      const url = (data["temp_url"] ?? data["url"] ?? nested?.["temp_url"] ?? nested?.["url"] ?? null) as string | null;
      return url;
    } catch {
      return null;
    }
  }
}
