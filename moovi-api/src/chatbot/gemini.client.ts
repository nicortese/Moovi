import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

const PRIMARY_MODEL = 'gemini-3.8-flash';
const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
const MAX_EXTRA_RETRIES = 2;
const RETRY_DELAYS_MS = [700, 1600];
const REQUEST_TIMEOUT_MS = 8_000;
const TOTAL_BUDGET_MS = 26_000;

export type GeminiSchema = Record<string, any>;

@Injectable()
export class GeminiClient {
  private readonly logger = new Logger(GeminiClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly cfg: ConfigService,
  ) {}

  /**
   * Llama a Gemini y devuelve el texto del primer candidato.
   * Si se pasa `schema`, le pide a Gemini salida JSON con ese formato.
   * Ante un 503 reintenta el modelo principal y, si sigue saturado, usa el alternativo.
   */
  async generate(opts: {
    system: string;
    user: string;
    schema?: GeminiSchema;
  }): Promise<string> {
    const apiKey = this.cfg.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      this.logger.error('GEMINI_API_KEY no está configurada en el .env');
      throw new ServiceUnavailableException('Chatbot no configurado');
    }

    const body: Record<string, any> = {
      system_instruction: { parts: [{ text: opts.system }] },
      contents: [{ role: 'user', parts: [{ text: opts.user }] }],
      generationConfig: {
        temperature: 0.7,
        ...(opts.schema
          ? { responseMimeType: 'application/json', responseSchema: opts.schema }
          : {}),
      },
    };

    const started = Date.now();
    for (let attempt = 0; attempt <= MAX_EXTRA_RETRIES; attempt++) {
      if (attempt > 0 && Date.now() - started > TOTAL_BUDGET_MS) break;
      try {
        const text = await this.request(PRIMARY_MODEL, body, apiKey);
        this.logger.log(`Gemini respondió con ${PRIMARY_MODEL}`);
        return text;
      } catch (err) {
        if (err instanceof ServiceUnavailableException) throw err;
        if (!this.isTransientCapacity(err)) {
          this.logGeminiError(PRIMARY_MODEL, err);
          throw new ServiceUnavailableException('No se pudo contactar al chatbot');
        }
        if (attempt === MAX_EXTRA_RETRIES) break;
        this.logger.warn(
          `Gemini ${PRIMARY_MODEL} falló de forma transitoria (${this.failureLabel(err)}); reintento ${attempt + 1}/${MAX_EXTRA_RETRIES}`,
        );
        await this.delay(RETRY_DELAYS_MS[attempt]);
      }
    }

    this.logger.warn(
      `Gemini ${PRIMARY_MODEL} no disponible tras reintentos; usando ${FALLBACK_MODEL}`,
    );
    try {
      const text = await this.request(FALLBACK_MODEL, body, apiKey);
      this.logger.log(`Gemini respondió con ${FALLBACK_MODEL} (fallback)`);
      return text;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logGeminiError(FALLBACK_MODEL, err);
      throw new ServiceUnavailableException('No se pudo contactar al chatbot');
    }
  }

  private request(model: string, body: Record<string, any>, apiKey: string) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    return firstValueFrom(
      this.http.post(url, body, {
        params: { key: apiKey },
        timeout: REQUEST_TIMEOUT_MS,
      }),
    ).then((res) => {
      const text: string | undefined =
        res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        this.logger.warn(`Gemini ${model} respondió sin texto`);
        throw new ServiceUnavailableException('El chatbot no devolvió respuesta');
      }
      return text;
    });
  }

  private isTransientCapacity(err: any): boolean {
    const response = err?.response ?? err?.cause?.response;
    const axiosCode = err?.code ?? err?.cause?.code;
    const code = response?.data?.error?.code;
    return (
      response?.status === 503 ||
      code === 503 ||
      axiosCode === 'ECONNABORTED' ||
      axiosCode === 'ETIMEDOUT'
    );
  }

  private failureLabel(err: any): string {
    const response = err?.response ?? err?.cause?.response;
    if (response?.status === 503 || response?.data?.error?.code === 503) return '503';
    const axiosCode = err?.code ?? err?.cause?.code;
    return typeof axiosCode === 'string' ? axiosCode : '503';
  }

  private logGeminiError(model: string, err: any) {
    const response = err?.response ?? err?.cause?.response;
    const error = response?.data?.error;
    const httpStatus = response?.status ?? error?.code ?? 'n/a';
    const status = typeof error?.status === 'string' ? error.status : 'n/a';
    const axiosCode = err?.code ?? err?.cause?.code ?? 'n/a';
    const message = (typeof error?.message === 'string' ? error.message : 'sin detalle')
      .replace(/key=[^&\s]+/gi, 'key=[redacted]')
      .slice(0, 300);
    this.logger.error(
      `Error llamando a Gemini (${model}): http=${httpStatus} status=${status} code=${axiosCode} ${message}`,
    );
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
