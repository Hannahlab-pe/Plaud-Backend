import https from "https";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Estructura del resumen — siempre se aplica
const SUMMARY_STRUCTURE = `
Tu trabajo es producir resumenes densos, utiles y accionables — no parafrasis vagas.

Reglas:
- Usa nombres reales de personas, empresas, sistemas y fechas que aparezcan en la transcripcion
- Si alguien dijo algo importante, cita sus palabras entre comillas
- Se especifico: no escribas "se discutio el proceso" sino "Cristian propuso migrar los datos antes del 30 de junio porque ODU no soporta reportes consolidados"
- Si hay tension, desacuerdo o problema sin resolver, mencionalos explicitamente
- Los proximos pasos deben tener responsable y fecha si se mencionaron

Genera el resumen en espanol con esta estructura:

## Resumen ejecutivo
(3-5 oraciones densas que capturen el QUE, POR QUE y resultado de la reunion)

## Contexto y antecedentes
(que situacion o problema previo motivo esta reunion)

## Temas discutidos en detalle
(para cada tema importante: que se dijo, quien lo planteo, que posiciones hubo)

## Decisiones tomadas
- (decision concreta — responsable si se menciona)

## Problemas o bloqueos identificados
- (obstaculos, riesgos o puntos sin resolver)

## Proximos pasos
- (accion especifica — responsable — fecha si se menciona)

## Participantes
- (nombres mencionados con su rol si se puede inferir)

Si un bloque genuinamente no aplica, eliminalo. No escribas "No aplica".
No agregues introducciones ni conclusiones fuera de la estructura.`;

// Prompt por defecto (sin skill)
const DEFAULT_PROMPT = `Eres un analista experto en reuniones de negocios.${SUMMARY_STRUCTURE}`;

function buildPrompt(customSkillPrompt?: string): string {
  if (customSkillPrompt) {
    return `${customSkillPrompt}${SUMMARY_STRUCTURE}`;
  }
  return DEFAULT_PROMPT;
}

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

export async function summarize(transcript: string, customSkillPrompt?: string): Promise<string> {
  const prompt = buildPrompt(customSkillPrompt);

  if (anthropic) {
    console.log(`  Resumiendo con Claude...`);
    const message = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL ?? "claude-opus-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: `${prompt}\n\n---TRANSCRIPCION---\n${transcript}` }],
    });
    return message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");
  }

  console.log(`  Resumiendo con GPT-4o...`);
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 4096,
    messages: [
      { role: "system", content: prompt },
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
