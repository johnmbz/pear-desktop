import * as z from 'zod';

import { LRC } from '../parsers/lrc';
import { netFetch } from '../renderer';
import { config } from '../renderer/renderer';

import type { LyricProvider, LyricResult, SearchSongInfo } from '../types';

const HONEYPOT_SNIPPETS = ['wob gopini den', 'tefe woxica fero'];

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const isHoneypotLyrics = (raw: string | undefined): boolean => {
  if (!raw) return false;
  const normalized = raw
    .replace(/\[\d+:\d+(?:\.\d+)?\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return HONEYPOT_SNIPPETS.some((snippet) => normalized.includes(snippet));
};

export class MusixMatch implements LyricProvider {
  name = 'MusixMatch';
  baseUrl = 'https://www.musixmatch.com/';

  private apiPromise: Promise<MusixMatchAPI> | undefined;

  private getApi(): Promise<MusixMatchAPI> {
    this.apiPromise ??= MusixMatchAPI.new().catch((error: unknown) => {
      this.apiPromise = undefined;
      throw error;
    });
    return this.apiPromise;
  }

  async search(info: SearchSongInfo): Promise<LyricResult | null> {
    // late-init the API, to avoid an electron IPC issue
    // an added benefit is that if it has an error during init, the user can hit the retry button
    const api = await this.getApi();
    await api.reinit();

    const data = await api.query(Endpoint.getMacroSubtitles, {
      q_track: info.alternativeTitle || info.title,
      q_artist: info.artist,
      ...(info.album ? { q_album: info.album } : {}),
      namespace: 'lyrics_richsynched',
      subtitle_format: 'lrc',
    });

    const { macro_calls: macroCalls } = data.body;

    // prettier-ignore
    const getter = <T extends keyof typeof macroCalls>(key: T): typeof macroCalls[T]['message']['body'] => macroCalls[key].message.body;

    const track = getter('matcher.track.get')?.track;
    const lyrics = getter('track.lyrics.get')?.lyrics?.lyrics_body;
    const subtitle = getter('track.subtitles.get')?.subtitle_list?.[0];

    // either no track found, or musixmatch's algorithm returned "Coldplay - Paradise" for no reason whatsoever
    if (!track || track.track_id === 115264642) return null;

    if (
      !config()?.showLyricsEvenIfInexact &&
      track.track_length !== undefined &&
      Math.abs(track.track_length - info.songDuration) > 15
    ) {
      return null;
    }

    const subtitleBody = subtitle?.subtitle.subtitle_body;
    const validSubtitle = isHoneypotLyrics(subtitleBody)
      ? undefined
      : subtitleBody;
    const validLyrics = isHoneypotLyrics(lyrics) ? undefined : lyrics;

    if (!validSubtitle && !validLyrics) return null;

    return {
      title: track.track_name,
      artists: [track.artist_name],
      lines: validSubtitle
        ? LRC.parse(validSubtitle).lines.map((l) => ({
            ...l,
            status: 'upcoming' as const,
          }))
        : undefined,
      lyrics: validLyrics,
    };
  }
}

// API Implementation, based on https://github.com/Strvm/musicxmatch-api/blob/main/src/musicxmatch_api/main.py

const zBoolean = z.union([z.literal(0), z.literal(1)]);
const Track = z.object({
  track_id: z.number(),
  track_name: z.string(),
  artist_name: z.string(),
  track_length: z.number().optional(),
});

const Lyrics = z.object({
  instrumental: zBoolean.optional(),
  lyrics_body: z.string(),
  lyrics_language: z.string().optional(),
  lyrics_language_description: z.string().optional(),
});

const Subtitle = z.object({
  subtitle_body: z.string(),
  subtitle_length: z.number().optional(),
  subtitle_language: z.string().optional(),
});

enum Endpoint {
  getMacroSubtitles = 'macro.subtitles.get',
  searchTrack = 'track.search',
}

type Query = {
  q?: string;
  q_track?: string;
  q_artist?: string;
  q_album?: string;
  q_duration?: string;
};

type Params = {
  [Endpoint.getMacroSubtitles]: Query & {
    namespace: 'lyrics_richsynched';
    subtitle_format: 'lrc';
  };
  [Endpoint.searchTrack]: {
    q: string;
    f_has_lyrics: 'true' | 'false';
    page_size: string;
    page: string;
  };
};

const ResponseSchema = {
  [Endpoint.searchTrack]: z.object({
    track_list: z.array(z.object({ track: Track })),
  }),
  [Endpoint.getMacroSubtitles]: z.object({
    macro_calls: z.object({
      'track.lyrics.get': z.object({
        message: z.object({
          body: z
            .object({ lyrics: Lyrics })
            .or(
              z
                .instanceof(Array)
                .describe('default response for 404 status')
                .transform(() => undefined)
                .or(z.string().transform(() => undefined)),
            )
            .optional(),
        }),
      }),
      'track.subtitles.get': z.object({
        message: z.object({
          body: z
            .object({
              subtitle_list: z.array(z.object({ subtitle: Subtitle })),
            })
            .or(
              z
                .instanceof(Array)
                .describe('default response for 404 status')
                .transform(() => undefined)
                .or(z.string().transform(() => undefined)),
            )

            .optional(),
        }),
      }),
      'matcher.track.get': z.object({
        message: z.object({
          body: z
            .object({ track: Track })
            .or(
              z
                .instanceof(Array)
                .describe('default response for 404 status')
                .transform(() => undefined)
                .or(z.string().transform(() => undefined)),
            )
            .optional(),
        }),
      }),
    }),
  }),
} as const;

class MusixMatchAPI {
  private initPromise: Promise<void>;
  private token: string | null = null;
  private requestQueue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  private constructor() {
    this.initPromise = this.init();
  }

  public static async new() {
    const api = new MusixMatchAPI();
    await api.initPromise;
    return api;
  }

  private isValidToken(token: string | null | undefined): token is string {
    return Boolean(token && token.length > 8 && !/^(.)\1+$/.test(token));
  }

  private throttledFetch(url: string) {
    const run = async () => {
      const elapsed = Date.now() - this.lastRequestAt;
      if (elapsed < 900) {
        await sleep(900 - elapsed);
      }
      this.lastRequestAt = Date.now();
      return netFetch(url, {
        credentials: 'omit',
        headers: this.headers,
      });
    };

    const next = this.requestQueue.then(run, run);
    this.requestQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  public async reinit(force = false) {
    const [{ status }] = await Promise.allSettled([this.initPromise]);
    let expired: boolean;
    try {
      const saved = this.savedTokenSchema.parse(
        JSON.parse(localStorage.getItem(this.key) ?? '{ "token": null }'),
      );
      expired =
        !this.isValidToken(saved.token) ||
        !saved.expires ||
        saved.expires <= Date.now();
    } catch {
      expired = true;
    }

    if (force || status === 'rejected' || expired) {
      localStorage.removeItem(this.key);
      this.initPromise = this.init();
      await this.initPromise;
    }
  }

  // god I love typescript generics, they're so useful
  public async query<
    T extends Endpoint,
    R = {
      header: { status_code: number };
      body: T extends keyof typeof ResponseSchema
        ? z.infer<(typeof ResponseSchema)[T]>
        : unknown;
    },
  >(endpoint: T, params: Params[T], retried = false): Promise<R> {
    await this.initPromise;
    if (!this.token) throw new Error('Token not initialized');

    const url = `${this.baseUrl}${endpoint}`;

    const clonedParams = new URLSearchParams(
      Object.assign(
        {
          app_id: this.app_id,
          format: 'json',
          usertoken: this.token,
        },
        params as Record<string, string>,
      ),
    );

    const [, json] = await this.throttledFetch(`${url}?${clonedParams}`);

    const response: unknown = JSON.parse(json);
    // prettier-ignore
    if (
      response && typeof response === 'object' &&
      'message' in response && response.message && typeof response.message === 'object' &&
      'header' in response.message && response.message.header && typeof response.message.header === 'object' &&
      'status_code' in response.message.header && typeof response.message.header.status_code === 'number' &&
      response.message.header.status_code === 401
    ) {
      if (retried) {
        throw new Error('MusixMatch API unauthorized (401)');
      }
      const hint =
        'hint' in response.message.header &&
        typeof response.message.header.hint === 'string'
          ? response.message.header.hint
          : '';
      if (hint === 'captcha') {
        await sleep(1500);
        return this.query(endpoint, params, true);
      }
      await sleep(1000);
      await this.reinit(true);
      return this.query(endpoint, params, true);
    }

    const parsed = z
      .object({
        message: z.object({ body: ResponseSchema[endpoint] }),
      })
      .safeParse(response);

    if (!parsed.success) {
      console.error('Malformed response', response, parsed.error);
      throw new Error('Failed to parse response from MusixMatch API');
    }

    return parsed.data.message as R;
  }

  private savedTokenSchema = z.union([
    z.object({
      token: z.literal(null),
      expires: z.number().optional(),
    }),
    z.object({
      token: z.string(),
      expires: z.number(),
    }),
  ]);

  private key = 'ytm:synced-lyrics:mxm:mobile-token';
  private async init() {
    localStorage.removeItem('ytm:synced-lyrics:mxm:token');

    try {
      const { token, expires } = this.savedTokenSchema.parse(
        JSON.parse(localStorage.getItem(this.key) ?? '{ "token": null }'),
      );
      if (this.isValidToken(token) && expires && expires > Date.now()) {
        this.token = token;
        return;
      }
    } catch {
      // Ignore malformed cached entry
    }

    localStorage.removeItem(this.key);

    this.token = await this.getToken();
    if (!this.isValidToken(this.token)) throw new Error('Failed to get token');

    localStorage.setItem(
      this.key,
      JSON.stringify({
        token: this.token,
        expires: Date.now() + 21_600_000,
      }),
    );
  }

  private tokenSchema = z.object({
    message: z.object({
      body: z
        .object({
          user_token: z.string(),
        })
        .or(z.instanceof(Array).transform(() => undefined))
        .optional(),
    }),
  });
  private async getToken() {
    const endpoint = 'token.get';
    const params = new URLSearchParams({ app_id: this.app_id });
    const [, json] = await this.throttledFetch(
      `${this.baseUrl}${endpoint}?${params}`,
    );

    const {
      message: { body },
    } = this.tokenSchema.parse(JSON.parse(json));
    return body?.user_token ?? '';
  }

  private readonly baseUrl = 'https://apic-appmobile.musixmatch.com/ws/1.1/';
  private readonly app_id = 'mac-ios-v2.0';
  private readonly headers = {
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Authority': 'apic-appmobile.musixmatch.com',
    'X-Cookie': 'x-mxm-token-guid=',
    'X-User-Agent': 'Musixmatch/2025120901 CFNetwork/3860.300.31 Darwin/25.2.0',
    'x-mxm-app-version': '10.1.1',
  } as const;
}
