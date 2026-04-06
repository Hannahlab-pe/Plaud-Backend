import https from "https";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Plantilla de resumen — puedes personalizarla para tu industria
const SUMMARY_PROMPT = `Eres un asistente especializado en resumir reuniones de trabajo con clientes.

A continuacion tienes la transcripcion de una reunion. Genera un resumen estructurado en espanol con este formato exacto:

## Resumen ejecutivo
(2-3 oraciones con la idea principal de la reunion)

## Puntos clave discutidos
- (lista de los temas mas importantes)

## Acuerdos y compromisos
- (lista de decisiones tomadas o compromisos adquiridos, con responsable si se menciona)

## Proximos pasos
- (lista de acciones a tomar, con fecha si se menciona)

## Participantes mencionados
- (nombres de personas o empresas mencionadas)

Si algun bloque no aplica para esta reunion, escribe "No aplica" en ese bloque.
Se directo y conciso. No agregues comentarios fuera de la estructura.`;

function downloadAudio(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function summarize(transcript: string): Promise<string> {
  // Preferencia: Claude si esta configurado, si no GPT-4o
  if (anthropic) {
    console.log(`  Resumiendo con Claude...`);
    const message = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL ?? "claude-opus-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: `${SUMMARY_PROMPT}\n\n---TRANSCRIPCION---\n${transcript}` }],
    });
    return message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");
  }

  console.log(`  Resumiendo con GPT-4o...`);
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 1024,
    messages: [
      { role: "system", content: SUMMARY_PROMPT },
      { role: "user", content: `---TRANSCRIPCION---\n${transcript}` },
    ],
  });
  return response.choices[0]?.message?.content ?? "";
}

export interface ProcessedResult {
  transcript: string;
  summary: string;
}

export async function processAudio(audioUrl: string, filename: string): Promise<ProcessedResult> {
  console.log(`  Descargando audio: ${filename}`);
  const audioBuffer = await downloadAudio(audioUrl);

  const file = new File([audioBuffer], `${filename}.mp3`, { type: "audio/mpeg" });

  console.log(`  Transcribiendo con Whisper (${Math.round(audioBuffer.length / 1024)}KB)...`);
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    response_format: "text",
    // Sin "language" para auto-detectar el idioma de la reunion
  });

  const transcript = typeof transcription === "string"
    ? transcription
    : (transcription as { text: string }).text;

  console.log(`  Transcripcion lista (${transcript.length} chars)`);

  if (!transcript.trim()) {
    return { transcript: "", summary: "" };
  }

  const summary = await summarize(transcript);
  console.log(`  Resumen listo`);
  return { transcript, summary };
}
