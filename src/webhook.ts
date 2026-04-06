import { Request, Response } from "express";
import crypto from "crypto";
import { pool } from "./db";

// Payload que Plaud envia cuando una transcripcion completa
interface PlaudWebhookPayload {
  transcription_id: string;
  status: "SUCCESS" | "FAILURE" | "REVOKED";
  language?: string;
  duration?: number;
  segments?: Array<{
    speaker: string;
    start: number;
    end: number;
    text: string;
  }>;
  summary?: string;
}

function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // Plaud envia la firma como "sha256=<hex>"
  const received = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;

  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(received, "hex")
  );
}

function buildTranscript(
  segments?: PlaudWebhookPayload["segments"]
): string | null {
  if (!segments || segments.length === 0) return null;

  return segments
    .map((s) => `[${s.speaker}] ${s.text}`)
    .join("\n");
}

export async function handleWebhook(req: Request, res: Response): Promise<void> {
  const secret = process.env.PLAUD_CLIENT_SECRET_KEY;

  if (!secret) {
    console.error("PLAUD_CLIENT_SECRET_KEY no esta configurado en .env");
    res.status(500).json({ error: "Configuracion del servidor incompleta" });
    return;
  }

  // Verificar firma HMAC-SHA256
  const signature = req.headers["x-plaud-signature"] as string | undefined;
  const rawBody: Buffer = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));

  if (!verifySignature(rawBody, signature, secret)) {
    console.warn("Firma invalida en webhook recibido");
    res.status(401).json({ error: "Firma invalida" });
    return;
  }

  const payload = req.body as PlaudWebhookPayload;

  console.log(`Webhook recibido: ${payload.transcription_id} — status: ${payload.status}`);

  const transcript = buildTranscript(payload.segments);
  const speakers = payload.segments
    ? [...new Set(payload.segments.map((s) => s.speaker))]
    : [];

  try {
    await pool.query(
      `INSERT INTO recordings
        (recording_id, status, language, duration_seconds, transcript, summary, speakers, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (recording_id)
       DO UPDATE SET
         status           = EXCLUDED.status,
         language         = EXCLUDED.language,
         duration_seconds = EXCLUDED.duration_seconds,
         transcript       = EXCLUDED.transcript,
         summary          = EXCLUDED.summary,
         speakers         = EXCLUDED.speakers,
         raw_payload      = EXCLUDED.raw_payload`,
      [
        payload.transcription_id,
        payload.status,
        payload.language ?? null,
        payload.duration ?? null,
        transcript,
        payload.summary ?? null,
        JSON.stringify(speakers),
        JSON.stringify(payload),
      ]
    );

    console.log(`Grabacion guardada: ${payload.transcription_id}`);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Error al guardar en base de datos:", err);
    res.status(500).json({ error: "Error interno al guardar la grabacion" });
  }
}
