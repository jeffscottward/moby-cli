// Tests use synthetic fixtures only. No real Moby content, tokens or accounts.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobyClient, type AuthState } from "../src/client.ts";
import { main } from "../src/cli.ts";
import page from "./fixtures/documents-page.json";
import search from "./fixtures/search.json";

const jwt = (exp: number) =>
  ["e30", Buffer.from(JSON.stringify({ exp, iss: "test" })).toString("base64url"), "sig"].join(".");

function setup(handler: (url: string, init: RequestInit) => Response, state?: Partial<AuthState>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let saved: AuthState | undefined;
  let clock = 1_800_000_000_000;
  const client = new MobyClient({
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }) as typeof fetch,
    auth: {
      load: () => ({ mobyToken: jwt(clock / 1000 + 30 * 86400), ...state }),
      save: (s) => (saved = s),
    },
    cacheDir: mkdtempSync(join(tmpdir(), "moby-test-")),
    minIntervalMs: 500,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  });
  return { client, calls, saved: () => saved };
}

describe("MobyClient", () => {
  test("ideas posts the stock-picks query with client headers", async () => {
    const { client, calls } = setup(() => Response.json(page));
    const r = await client.ideas(5);
    expect(r.items[0]!.stockSymbol).toBe("TEST");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ type: "stockPicksArticle", perPage: 5, page: 1, sortBy: "publishedAt" });
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toStartWith("Bearer ");
    expect(h["x-client-platform"]).toBe("WEB");
  });

  test("caches identical requests", async () => {
    const { client, calls } = setup(() => Response.json(page));
    await client.ideas(5);
    await client.ideas(5);
    expect(calls.length).toBe(1);
  });

  test("search encodes the query", async () => {
    const { client, calls } = setup(() => Response.json(search));
    const r = await client.search("a b&c");
    expect(calls[0]!.url).toEndWith("/search/articles?query=a%20b%26c");
    expect(r.companies?.[0]?.ticker).toBe("TEST");
  });

  test("retries once on 401 after refreshing the token", async () => {
    let n = 0;
    const { client, calls, saved } = setup(
      (url) => {
        if (url.includes("securetoken")) return Response.json({ id_token: "fb-id", refresh_token: "rt2" });
        if (url.endsWith("/auth/refresh")) return new Response('{"success":true}', { headers: { authorization: "Bearer new-token" } });
        return ++n === 1 ? new Response("{}", { status: 401 }) : Response.json(page);
      },
      { firebaseApiKey: "k", firebaseRefreshToken: "rt" },
    );
    await client.ideas(1);
    expect(saved()?.mobyToken).toBe("new-token");
    expect(saved()?.firebaseRefreshToken).toBe("rt2");
    const last = calls.at(-1)!.init.headers as Record<string, string>;
    expect(last.authorization).toBe("Bearer new-token");
  });

  test("export pages until the limit", async () => {
    const { client, calls } = setup((_, init) => {
      const b = JSON.parse(String(init.body));
      return Response.json({ ...page, page: b.page, total: 5, items: Array.from({ length: b.perPage }, (_, i) => ({ ...page.items[0], id: `${b.page}-${i}` })) });
    });
    const items = await client.exportDocuments("newsArticle", 5, 2);
    expect(items.length).toBe(5);
    expect(calls.length).toBe(3);
  });

  test("raises a readable error on HTTP failure", async () => {
    const { client } = setup(() => Response.json({ status: 400, message: "Bad Request Exception" }, { status: 400 }));
    await expect(client.search("x")).rejects.toThrow("HTTP 400 Bad Request Exception");
  });
});

describe("cli", () => {
  test("ideas --json prints the items array", async () => {
    const { client } = setup(() => Response.json(page));
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: string) => logs.push(s);
    try {
      expect(await main(["ideas", "--limit", "1", "--json"], client)).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(JSON.parse(logs.join("\n"))[0].slug).toBe("synthetic-test-pick");
  });
});
