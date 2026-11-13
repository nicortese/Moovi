import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

// TMDB provider_id → our platform slug
export const PROVIDER_MAP: Record<number, string> = {
  8: 'netflix',
  11: 'mubi',
  119: 'amazon-prime',
  167: 'clarovideo',
  283: 'crunchyroll',
  300: 'pluto-tv',
  337: 'disney-plus',
  350: 'apple-tv',
  384: 'hbo',
  531: 'paramount-plus',
  619: 'star-plus',
  1870: 'hbo',
  1899: 'hbo',
};

export const SUPPORTED_PROVIDERS = new Set(Object.keys(PROVIDER_MAP).map(Number));

@Injectable()
export class TmdbClient {
  private readonly logger = new Logger(TmdbClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly cfg: ConfigService,
  ) {}

  private get headers() {
    return { Authorization: `Bearer ${this.cfg.get('TMDB_ACCESS_TOKEN')}` };
  }

  private async get<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const url = `https://api.themoviedb.org/3${path}`;
    const fallbackDelays = [1000, 3000];

    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const res = await firstValueFrom(
          this.http.get<T>(url, { headers: this.headers, params }),
        );
        return res.data;
      } catch (err) {
        if (attempt === 2 || !this.isTransient(err)) throw err;
        const wait = this.retryDelay(err, fallbackDelays[attempt]);
        this.logger.warn(
          `TMDB respondió ${this.failureLabel(err)}; reintento ${attempt + 1}/2 en ${wait} ms`,
        );
        await this.delay(wait);
      }
    }

    throw new Error('TMDB no respondió');
  }

  private isTransient(err: any): boolean {
    const status = err?.response?.status ?? err?.cause?.response?.status;
    if (status === 429 || status === 502 || status === 503 || status === 504) return true;
    if (status) return false;
    const code = err?.code ?? err?.cause?.code;
    return (
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNABORTED' ||
      code === 'EAI_AGAIN'
    );
  }

  private retryDelay(err: any, fallbackMs: number): number {
    const header = err?.response?.headers?.['retry-after'] ?? err?.cause?.response?.headers?.['retry-after'];
    if (header == null || header === '') return fallbackMs;

    const seconds = Number(header);
    const waitMs = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(String(header)) - Date.now();
    if (!Number.isFinite(waitMs) || waitMs < 0) return fallbackMs;
    return Math.min(waitMs, 10_000);
  }

  private failureLabel(err: any): string {
    const status = err?.response?.status ?? err?.cause?.response?.status;
    if (status) return String(status);
    const code = err?.code ?? err?.cause?.code;
    return typeof code === 'string' ? code : 'error de red';
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async getTrending(page = 1): Promise<any[]> {
    const data = await this.get<any>('/trending/all/week', { page, language: 'es-AR' });
    return data.results ?? [];
  }

  async getPopularTV(page = 1): Promise<any[]> {
    const data = await this.get<any>('/tv/popular', { page, language: 'es-AR' });
    return data.results ?? [];
  }

  async getPopularMovies(page = 1): Promise<any[]> {
    const data = await this.get<any>('/movie/popular', { page, language: 'es-AR' });
    return data.results ?? [];
  }

  async discoverByProvider(
    providerId: number,
    mediaType: 'tv' | 'movie',
    page = 1,
    country = 'AR',
  ): Promise<any[]> {
    const data = await this.get<any>(`/discover/${mediaType}`, {
      page,
      language: 'es-AR',
      watch_region: country,
      with_watch_providers: String(providerId),
      sort_by: 'popularity.desc',
    });
    return data.results ?? [];
  }

  async getWatchProviders(tmdbId: number, type: 'tv' | 'movie', country: string): Promise<{ slug: string; providerId: number } | null> {
    try {
      const data = await this.get<any>(`/${type}/${tmdbId}/watch/providers`);
      const region = data.results?.[country];
      const flatrate: any[] = region?.flatrate ?? [];
      for (const p of flatrate) {
        if (SUPPORTED_PROVIDERS.has(p.provider_id)) {
          const slug = PROVIDER_MAP[p.provider_id];
          if (slug) return { slug, providerId: p.provider_id };
        }
      }
    } catch {
      // title not available in country
    }
    return null;
  }

  async getTVDetails(tmdbId: number, language = 'es-AR'): Promise<any> {
    return this.get<any>(`/tv/${tmdbId}`, { language });
  }

  async getMovieDetails(tmdbId: number, language = 'es-AR'): Promise<any> {
    return this.get<any>(`/movie/${tmdbId}`, { language });
  }

  async getTVContentRating(tmdbId: number, country = 'AR'): Promise<string | null> {
    try {
      const data = await this.get<any>(`/tv/${tmdbId}/content_ratings`);
      return pickContentRating(data.results ?? [], country, (row) => row.rating);
    } catch {
      return null;
    }
  }

  async getMovieContentRating(tmdbId: number, country = 'AR'): Promise<string | null> {
    try {
      const data = await this.get<any>(`/movie/${tmdbId}/release_dates`);
      return pickContentRating(data.results ?? [], country, (row) => {
        const cert = (row.release_dates ?? []).find((rd: any) => rd.certification?.trim())?.certification;
        return cert ?? null;
      });
    } catch {
      return null;
    }
  }

  async getContentRating(
    tmdbId: number,
    mediaType: 'tv' | 'movie',
    country = 'AR',
  ): Promise<string | null> {
    return mediaType === 'tv'
      ? this.getTVContentRating(tmdbId, country)
      : this.getMovieContentRating(tmdbId, country);
  }

  posterUrl(path: string | null): string | null {
    return path ? `${IMAGE_BASE}${path}` : null;
  }
}

export function toSlug(title: string, tmdbId: number): string {
  return (
    title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .substring(0, 200) +
    '-' +
    tmdbId
  );
}

const RATING_COUNTRY_FALLBACK = ['AR', 'US', 'ES', 'MX', 'GB'] as const;

function pickContentRating(
  rows: any[],
  preferredCountry: string,
  readRating: (row: any) => string | null | undefined,
): string | null {
  const order = [
    preferredCountry,
    ...RATING_COUNTRY_FALLBACK.filter((code) => code !== preferredCountry),
  ];

  for (const code of order) {
    const row = rows.find((entry) => entry.iso_3166_1 === code);
    const rating = row ? readRating(row)?.trim() : null;
    if (rating) return rating;
  }

  return null;
}

export function certToAgeRating(cert: string | null | undefined): number | null {
  if (!cert?.trim()) return null;

  const normalized = cert.trim().toUpperCase();

  const exact: Record<string, number> = {
    G: 0,
    U: 0,
    TP: 0,
    ATP: 0,
    'ALL': 0,
    'ALL AGES': 0,
    PG: 7,
    '7': 7,
    'PG-7': 7,
    '+7': 7,
    'TV-G': 0,
    'TV-Y': 0,
    'TV-Y7': 7,
    'TV-Y7-FV': 7,
    'PG-13': 13,
    '13': 13,
    '+13': 13,
    'TV-PG': 10,
    'TV-14': 14,
    '14': 14,
    '+14': 14,
    R: 16,
    '16': 16,
    '+16': 16,
    'NC-17': 18,
    '18': 18,
    '+18': 18,
    'TV-MA': 18,
    MA: 18,
    A: 0,
    AA: 0,
    B: 13,
    C: 18,
  };

  if (exact[normalized] != null) return exact[normalized];

  const sam = normalized.match(/^SAM\s*(\d{1,2})$/);
  if (sam) return Number(sam[1]);

  const plus = normalized.match(/^\+?(\d{1,2})\+?$/);
  if (plus) return Number(plus[1]);

  const mexicoB = normalized.match(/^B-?(\d{1,2})$/);
  if (mexicoB) return Number(mexicoB[1]);

  const embeddedAge = normalized.match(/(\d{1,2})/);
  if (embeddedAge) return Number(embeddedAge[1]);

  return null;
}

export function resolveAgeRating(
  cert: string | null | undefined,
  mediaType: 'tv' | 'movie',
  details?: { adult?: boolean },
): number | null {
  const fromCert = certToAgeRating(cert);
  if (fromCert != null) return fromCert;
  if (mediaType === 'movie' && details?.adult) return 18;
  return null;
}
