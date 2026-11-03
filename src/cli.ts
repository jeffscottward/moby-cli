#!/usr/bin/env bun
// moby-cli: terminal client for Moby (moby.co) research. Pretty output by default; --json for exact JSON.

import { writeFileSync } from "node:fs";
import { DOCUMENT_TYPES, MobyClient, MobyError, TYPE_ALIASES, type DocumentSummary } from "./client.ts";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c("1");
const dim = c("2");
const green = c("32");
const red = c("31");
const cyan = c("36");

const HELP = `${bold("moby-cli")} - Moby research from the terminal

${bold("Usage")}
  moby-cli ideas [--limit N] [--page N]        Latest stock picks
  moby-cli list <type> [--limit N] [--page N] [--query Q]
  moby-cli get <slug>                          One document (summary fields)
  moby-cli search <query>                      Search articles and companies
  moby-cli export <type> [--limit N] [--out FILE]   Save documents as JSON
  moby-cli earnings <start> <end>              Earnings schedule (YYYY-MM-DD)
  moby-cli auth status | auth refresh          Token expiry / renew token
  moby-cli types                               List known document types

${bold("Options")}
  --json        Print raw JSON (no colors), for jq
  --no-cache    Skip the local response cache (default TTL 10 min)

${bold("Types")}  ${Object.keys(TYPE_ALIASES).join(", ")} (or a raw API type)
`;

function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (["json", "no-cache", "help"].includes(k) || next === undefined || next.startsWith("--")) flags[k] = true;
      else flags[k] = argv[++i]!;
    } else if (a === "-h") flags.help = true;
    else pos.push(a);
  }
  return { pos, flags };
}

function num(v: string | boolean | undefined, def: number): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}

function pad(s: string, w: number): string {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.length >= w ? s : s + " ".repeat(w - plain.length);
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").replace(/\x1b\[[0-9;]*m/g, "").length)));
  return rows.map((r) => r.map((cell, i) => pad(cell, Math.min(widths[i]!, 70))).join("  ")).join("\n");
}

function trunc(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function renderDocs(items: DocumentSummary[]): string {
  if (items.length === 0) return dim("No items.");
  const rows = [["DATE", "TICKER", "HEADLINE", "UPSIDE", "SLUG"].map(dim)];
  for (const d of items) {
    const ticker = d.stockSymbol ?? d.company?.ticker ?? "";
    const up = typeof d.upsidePercentage === "number" ? d.upsidePercentage : undefined;
    rows.push([
      dim((d.publishedAt ?? "").slice(0, 10)),
      cyan(ticker),
      bold(trunc(d.headline, 60)),
      up === undefined ? "" : (up >= 0 ? green : red)(`${up.toFixed(1)}%`),
      dim(trunc(d.slug, 50)),
    ]);
  }
  return table(rows);
}

export async function main(argv: string[], client?: MobyClient): Promise<number> {
  const { pos, flags } = parse(argv);
  const [cmd, ...rest] = pos;
  const json = flags.json === true;
  const out = (v: unknown, pretty: () => string) => console.log(json ? JSON.stringify(v, null, 2) : pretty());
  if (!cmd || flags.help) {
    console.log(HELP);
    return cmd || flags.help ? 0 : 1;
  }
  const api = client ?? new MobyClient({ cacheTtlMs: flags["no-cache"] ? 0 : undefined });
  const typeOf = (t: string | undefined) => {
    if (!t) throw new MobyError(`Missing <type>. Use one of: ${Object.keys(TYPE_ALIASES).join(", ")}`, 2);
    return TYPE_ALIASES[t] ?? t;
  };

  switch (cmd) {
    case "ideas":
    case "list": {
      const type = cmd === "ideas" ? "stockPicksArticle" : typeOf(rest[0]);
      const r = await api.listDocuments({
        type,
        perPage: num(flags.limit, 10),
        page: num(flags.page, 1),
        query: typeof flags.query === "string" ? flags.query : "",
      });
      out(r.items, () => `${renderDocs(r.items)}\n${dim(`${r.items.length} of ${r.total} · page ${r.page} · ${type}`)}`);
      return 0;
    }
    case "get": {
      if (!rest[0]) throw new MobyError("Usage: moby-cli get <slug>", 2);
      const d = await api.getDocument(rest[0]);
      out(d, () =>
        [
          bold(d.headline ?? d.slug ?? d.id),
          d.subtitle ? dim(d.subtitle) : "",
          `${dim("type")}      ${d.type}`,
          `${dim("published")} ${d.publishedAt ?? ""}`,
          d.stockSymbol ? `${dim("ticker")}    ${cyan(d.stockSymbol)}` : "",
          d.postPrice !== undefined ? `${dim("price")}     ${d.postPrice}` : "",
          d.targetPrice !== undefined ? `${dim("target")}    ${d.targetPrice} by ${d.targetDate ?? "?"}` : "",
          d.upsidePercentage !== undefined ? `${dim("upside")}    ${d.upsidePercentage}%` : "",
          d.authorName ? `${dim("author")}    ${d.authorName}` : "",
          dim("Use --json for the full document."),
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return 0;
    }
    case "search": {
      const q = rest.join(" ");
      if (!q) throw new MobyError("Usage: moby-cli search <query>", 2);
      const r = await api.search(q);
      out(r, () => {
        const lines: string[] = [];
        if (r.companies?.length) lines.push(bold("Companies"), ...r.companies.map((co) => `  ${cyan(co.ticker ?? "")} ${co.name ?? ""}`), "");
        const rows = [["DATE", "TYPE", "TICKERS", "HEADLINE"].map(dim)];
        for (const i of r.items) rows.push([dim((i.publishedAt ?? "").slice(0, 10)), i.type, cyan((i.tickers ?? []).join(",")), bold(trunc(i.headline, 60))]);
        lines.push(bold("Articles"), table(rows));
        if (r.meta) lines.push(dim(Object.entries(r.meta).map(([k, v]) => `${k}=${v}`).join(" ")));
        return lines.join("\n");
      });
      return 0;
    }
    case "export": {
      const type = typeOf(rest[0]);
      const items = await api.exportDocuments(type, num(flags.limit, 50));
      const text = JSON.stringify(items, null, 2);
      if (typeof flags.out === "string") {
        writeFileSync(flags.out, text + "\n");
        console.error(dim(`Wrote ${items.length} ${type} items to ${flags.out}`));
      } else console.log(text);
      return 0;
    }
    case "earnings": {
      if (!rest[0] || !rest[1]) throw new MobyError("Usage: moby-cli earnings <start YYYY-MM-DD> <end YYYY-MM-DD>", 2);
      const r = await api.earningsSchedule(rest[0], rest[1]);
      out(r, () => JSON.stringify(r.schedule, null, 2));
      return 0;
    }
    case "auth": {
      if (rest[0] === "refresh") await api.refresh();
      const exp = api.tokenExpiry();
      const v = { expiresAt: exp ? new Date(exp * 1000).toISOString() : null };
      out(v, () => `${dim("token expires")} ${v.expiresAt ?? "unknown"}`);
      return 0;
    }
    case "types":
      out(DOCUMENT_TYPES, () => Object.entries(TYPE_ALIASES).map(([k, v]) => `${cyan(pad(k, 11))} ${v}`).join("\n"));
      return 0;
    default:
      console.error(red(`Unknown command: ${cmd}`));
      console.log(HELP);
      return 2;
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    console.error(red(e instanceof Error ? e.message : String(e)));
    process.exitCode = e instanceof MobyError && e.status === 2 ? 2 : 1;
  }
}
