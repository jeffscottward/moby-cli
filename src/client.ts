// Typed client for the private Moby (moby.co) web API at api.moby.co/api/v1.
// The API is undocumented. Endpoints and shapes were recovered from the
// app.moby.co web client. They can change without notice.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export const API_BASE = "https://api.moby.co/api/v1";
export const CLIENT_VERSION = "4.12.0";

/** Content types accepted by POST /content/documents. */
export const DOCUMENT_TYPES = [
  "stockPicksArticle",
  "newsArticle",
  "earningsArticle",
  "aiPortfolioArticle",
  "marketIntelligenceReport",
  "todayDailyDigestV2",
  "liveNewsArticle",
  "announcementBanner",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number] | (string & {});

/** Short names used by the CLI. */
export const TYPE_ALIASES: Record<string, DocumentType> = {
  ideas: "stockPicksArticle",
  picks: "stockPicksArticle",
  news: "newsArticle",
  earnings: "earningsArticle",
  portfolios: "aiPortfolioArticle",
  reports: "marketIntelligenceReport",
  digest: "todayDailyDigestV2",
};

export interface Company {
  name?: string;
  ticker?: string;
  darkLogoUrl?: string;
  lightLogoUrl?: string;
}

export interface DocumentSummary {
  id: string;
  type: string;
  headline?: string;
  slug?: string;
  publishedAt?: string;
  accessLevel?: string;
  stockSymbol?: string;
  targetDate?: string;
  targetPrice?: number;
  upsidePercentage?: number;
  authorName?: string;
  mainTopic?: string;
  portfolio?: string;
  company?: Company;
  [key: string]: unknown;
}

export interface DocumentPage {
  success: boolean;
  message?: string;
  items: DocumentSummary[];
  page: number;
  perPage: number;
  total: number;
  contentAccessLevel?: string;
}

export interface DocumentDetail extends DocumentSummary {
  subtitle?: string;
  postPrice?: number;
  sectors?: unknown[];
  topics?: unknown[];
  quickOverviewContent?: unknown[];
  deepDiveContent?: unknown[];
}

export interface SearchResult {
  success: boolean;
  items: Array<{
    id: string;
    type: string;
    headline?: string;
    slug?: string;
    publishedAt?: string;
    tickers?: string[];
  }>;
  meta?: Record<string, number>;
  companies?: Array<Company & { id?: string; slug?: string; domain?: string }>;
}

export interface ListOptions {
  type: DocumentType;
  page?: number;
  perPage?: number;
  query?: string;
  sortBy?: string | null;
  direction?: "asc" | "desc";
  filters?: unknown[];
}

/** Local auth state. Stored in ~/.config/moby/auth.json with mode 0600. */
export interface AuthState {
  /** Moby service JWT (sent as Authorization: Bearer). About 30 days lifetime. */
  mobyToken: string;
  /** Firebase web API key of the Moby app (public value, used for token refresh). */
  firebaseApiKey?: string;
  /** Firebase refresh token. Used to renew mobyToken without a browser. */
  firebaseRefreshToken?: string;
  savedAt?: string;
}

export function configDir(): string {
  return process.env.MOBY_CONFIG_DIR ?? join(homedir(), ".config", "moby");
}

export function decodeJwtExp(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

export class FileAuthStore {
  constructor(readonly path = join(configDir(), "auth.json")) {}
  load(): AuthState {
    if (process.env.MOBY_TOKEN) return { mobyToken: process.env.MOBY_TOKEN };
    if (!existsSync(this.path)) {
      throw new MobyError(`No auth file at ${this.path}. See README: "Authentication".`, 0);
    }
    const mode = statSync(this.path).mode & 0o077;
    if (mode !== 0) chmodSync(this.path, 0o600);
    return JSON.parse(readFileSync(this.path, "utf8")) as AuthState;
  }
  save(state: AuthState): void {
    if (process.env.MOBY_TOKEN) return;
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(state, null, 2), { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}

export class MobyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface ClientOptions {
  fetch?: typeof fetch;
  auth?: { load(): AuthState; save(s: AuthState): void };
  /** Minimum milliseconds between two network requests. Default 750. */
  minIntervalMs?: number;
  /** Cache lifetime in milliseconds. 0 turns the cache off. Default 10 minutes. */
  cacheTtlMs?: number;
  cacheDir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class MobyClient {
  private readonly fetchImpl: typeof fetch;
  private readonly auth: NonNullable<ClientOptions["auth"]>;
  private readonly minIntervalMs: number;
  private readonly cacheTtlMs: number;
  private readonly cacheDir: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastRequestAt = 0;
  private state?: AuthState;

  constructor(opts: ClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep =
      opts.sleep ??
      ((ms) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, ms);
        return promise;
      });
    this.auth = opts.auth ?? new FileAuthStore();
    this.minIntervalMs = opts.minIntervalMs ?? 750;
    this.cacheTtlMs = opts.cacheTtlMs ?? 10 * 60_000;
    this.cacheDir = opts.cacheDir ?? join(configDir(), "cache");
    this.now = opts.now ?? Date.now;
  }

  /** List documents of one type, newest first. */
  listDocuments(o: ListOptions): Promise<DocumentPage> {
    return this.request<DocumentPage>("POST", "/content/documents", {
      type: o.type,
      sortBy: o.sortBy === undefined ? "publishedAt" : o.sortBy,
      direction: o.direction ?? "desc",
      page: o.page ?? 1,
      perPage: o.perPage ?? 20,
      filters: o.filters ?? [],
      query: o.query ?? "",
      bannerType: null,
    });
  }

  /** Stock picks ("ideas"). */
  ideas(limit = 10, page = 1): Promise<DocumentPage> {
    return this.listDocuments({ type: "stockPicksArticle", perPage: limit, page });
  }

  /** One document by slug (or id where the API accepts it). */
  async getDocument(slug: string): Promise<DocumentDetail> {
    const r = await this.request<{ success: boolean; item: DocumentDetail }>(
      "GET",
      `/content/documents/${encodeURIComponent(slug)}`,
    );
    return r.item;
  }

  /** Full-text search across articles. Returns at most 10 items plus counts. */
  search(query: string): Promise<SearchResult> {
    return this.request<SearchResult>("GET", `/search/articles?query=${encodeURIComponent(query)}`);
  }

  earningsSchedule(startDate: string, endDate: string): Promise<{ schedule: Record<string, unknown> }> {
    const q = new URLSearchParams({ startDate, endDate });
    return this.request("GET", `/content/earnings-schedule?${q}`);
  }

  /** Fetch up to `limit` documents of one type across pages. */
  async exportDocuments(type: DocumentType, limit: number, perPage = 50): Promise<DocumentSummary[]> {
    const out: DocumentSummary[] = [];
    for (let page = 1; out.length < limit; page++) {
      const r = await this.listDocuments({ type, page, perPage: Math.min(perPage, limit - out.length) });
      out.push(...r.items);
      if (r.items.length === 0 || out.length >= r.total) break;
    }
    return out.slice(0, limit);
  }

  /** Expiry of the stored Moby token as epoch seconds, if readable. */
  tokenExpiry(): number | undefined {
    return decodeJwtExp(this.loadState().mobyToken);
  }

  /** Renew the Moby token with the Firebase refresh token. */
  async refresh(): Promise<void> {
    const s = this.loadState();
    if (!s.firebaseRefreshToken || !s.firebaseApiKey) {
      throw new MobyError("Token expired and no Firebase refresh token is stored. Log in again.", 401);
    }
    const st = await this.fetchImpl(
      `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(s.firebaseApiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", referer: "https://app.moby.co/" },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(s.firebaseRefreshToken)}`,
      },
    );
    if (!st.ok) throw new MobyError(`Firebase token refresh failed (HTTP ${st.status}).`, st.status);
    const sj = (await st.json()) as { id_token: string; refresh_token?: string };
    const r = await this.fetchImpl(`${API_BASE}/auth/refresh`, {
      method: "PUT",
      headers: { ...this.headers(s.mobyToken), "x-firebase-token": sj.id_token },
    });
    const h = r.headers.get("authorization");
    if (!r.ok || !h) throw new MobyError(`Moby token refresh failed (HTTP ${r.status}).`, r.status);
    this.state = {
      ...s,
      mobyToken: h.replace(/^Bearer\s+/i, ""),
      firebaseRefreshToken: sj.refresh_token ?? s.firebaseRefreshToken,
      savedAt: new Date(this.now()).toISOString(),
    };
    this.auth.save(this.state);
  }

  private loadState(): AuthState {
    this.state ??= this.auth.load();
    return this.state;
  }

  private headers(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json",
      "x-client-platform": "WEB",
      "x-client-version": CLIENT_VERSION,
    };
  }

  private cachePath(key: string): string {
    return join(this.cacheDir, createHash("sha256").update(key).digest("hex").slice(0, 32) + ".json");
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const key = `${method} ${path} ${body ? JSON.stringify(body) : ""}`;
    if (this.cacheTtlMs > 0) {
      const p = this.cachePath(key);
      if (existsSync(p)) {
        const hit = JSON.parse(readFileSync(p, "utf8")) as { at: number; data: T };
        if (this.now() - hit.at < this.cacheTtlMs) return hit.data;
      }
    }
    let s = this.loadState();
    const exp = decodeJwtExp(s.mobyToken);
    if (exp && exp * 1000 - this.now() < 24 * 3600_000 && s.firebaseRefreshToken) {
      await this.refresh();
      s = this.loadState();
    }
    let res = await this.send(method, path, body, s.mobyToken);
    if (res.status === 401 && s.firebaseRefreshToken) {
      await this.refresh();
      res = await this.send(method, path, body, this.loadState().mobyToken);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* empty body */
    }
    if (!res.ok) {
      const msg = (json as { message?: string } | null)?.message ?? res.statusText;
      throw new MobyError(`${method} ${path.split("?")[0]} failed: HTTP ${res.status} ${msg}`, res.status);
    }
    if (this.cacheTtlMs > 0) {
      mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
      writeFileSync(this.cachePath(key), JSON.stringify({ at: this.now(), data: json }), { mode: 0o600 });
    }
    return json as T;
  }

  private async send(method: string, path: string, body: unknown, token: string): Promise<Response> {
    const wait = this.lastRequestAt + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    for (let attempt = 0; ; attempt++) {
      this.lastRequestAt = this.now();
      const res = await this.fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: this.headers(token),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status !== 429 || attempt >= 2) return res;
      const ra = Number(res.headers.get("retry-after"));
      await this.sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 5000 * (attempt + 1));
    }
  }
}
