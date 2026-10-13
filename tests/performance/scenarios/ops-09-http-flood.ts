// OPS-09 (HTTP part) | Slow consumer + malformed request flood — bounded queues/body sizes/timeouts and
// /health remains responsive. Production server on a spare port. While /health is polled every 50 ms:
//  * flood: 2,000 bad requests at concurrency 64 (malformed JSON, oversized 1 MiB body, wrong content type,
//    missing CSRF, oversized header, unknown route, invalid move payload) with a valid guest session;
//  * slow clients: slowloris sockets (headers trickled 1 byte/s), slow body senders, and paused readers of
//    the largest bundled asset.
// WebSocket slow consumer / malformed frames: after BACKEND-005.
import { request } from "node:http";
import type { Agent } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import type { GameResponse } from "@g2048/contracts";
import { Client } from "../../integration/helpers/http.js";
import { PERCENTILE_METHOD, check, sleep, summarize, threshold } from "../lib/report.js";
import type { Scenario } from "../lib/report.js";
import { privateDataDir, startProdServer } from "../lib/server.js";

const FLOOD = 2_000;
const CONCURRENCY = 64;
const RESPONSE_BOUND_MS = 10_000;
const SLOW_SOCKETS = 20;
const SLOW_BOUND_MS = 90_000;

type Raw = { status: number | null; ms: number; error?: string };

function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string | Buffer,
): Promise<Raw> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers,
        agent: false as unknown as Agent,
        timeout: RESPONSE_BOUND_MS,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? null, ms: performance.now() - t0 }));
        res.on("error", (e) =>
          resolve({ status: res.statusCode ?? null, ms: performance.now() - t0, error: e.message }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("no response within bound")));
    req.on("error", (e) => resolve({ status: null, ms: performance.now() - t0, error: e.message }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Opens a socket, sends `prefix`, then trickles `trickle` one byte per second; resolves when the SERVER closes it. */
function slowSocket(
  port: number,
  prefix: string,
  trickle: string,
): Promise<{ closedAfterMs: number; byServer: boolean }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let i = 0;
    let timer: NodeJS.Timeout | undefined;
    const s: Socket = connect(port, "127.0.0.1", () => {
      s.write(prefix);
      timer = setInterval(() => {
        if (i < trickle.length && !s.destroyed) s.write(trickle[i++] as string);
      }, 1_000);
    });
    const done = (byServer: boolean) => {
      if (timer) clearInterval(timer);
      resolve({ closedAfterMs: Math.round(performance.now() - t0), byServer });
    };
    s.on("data", () => undefined);
    s.on("close", () => done(true));
    s.on("error", () => undefined);
    setTimeout(() => {
      if (!s.destroyed) {
        s.destroy();
        done(false);
      }
    }, SLOW_BOUND_MS);
  });
}

/** Requests a large asset and never reads the response; returns after `holdMs`. */
function pausedReader(port: number, path: string, holdMs: number): Promise<void> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1", () => {
      s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`);
      s.pause();
    });
    s.on("error", () => undefined);
    setTimeout(() => {
      s.destroy();
      resolve();
    }, holdMs);
  });
}

export const scenario: Scenario = {
  id: "OPS-09",
  title: "HTTP malformed/oversized flood + slow clients; /health responsiveness",
  async run() {
    const dataDir = privateDataDir("ops09");
    const server = await startProdServer(dataDir);
    const port = server.port;
    const health: number[] = [];
    const healthStatus: Record<string, number> = {};
    let polling = true;
    try {
      const c = new Client({ port });
      const g = await c.post<GameResponse>("/games", { mode: "classic", seed: "ops09" });
      if (g.status !== 201) throw new Error(`setup: ${g.status} ${g.text}`);
      const csrf = c.csrfToken ?? "";
      const cookie = c.cookieHeader();
      const origin = `http://127.0.0.1:${port}`;
      const base = {
        host: `127.0.0.1:${port}`,
        origin,
        "sec-fetch-site": "same-origin",
        cookie,
        "x-csrf-token": csrf,
      };
      const html = await (await fetch(`${origin}/`)).text();
      const bigAsset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? null;

      const healthLoop = (async () => {
        while (polling) {
          const r = await raw(port, "GET", "/api/v1/health", { host: `127.0.0.1:${port}` });
          health.push(r.ms);
          healthStatus[String(r.status)] = (healthStatus[String(r.status)] ?? 0) + 1;
          await sleep(50);
        }
      })();
      await sleep(1_000); // health baseline before load

      const kinds: { name: string; send: () => Promise<Raw> }[] = [
        {
          name: "malformed-json",
          send: () =>
            raw(
              port,
              "POST",
              "/api/v1/games",
              { ...base, "content-type": "application/json" },
              '{"mode":"classic",',
            ),
        },
        {
          name: "oversized-1MiB",
          send: () =>
            raw(
              port,
              "POST",
              "/api/v1/games",
              { ...base, "content-type": "application/json" },
              Buffer.alloc(1024 * 1024, 0x20),
            ),
        },
        {
          name: "wrong-content-type",
          send: () =>
            raw(port, "POST", "/api/v1/games", { ...base, "content-type": "text/plain" }, "mode=classic"),
        },
        {
          name: "missing-csrf",
          send: () =>
            raw(
              port,
              "POST",
              "/api/v1/games",
              { ...base, "x-csrf-token": "", "content-type": "application/json" },
              '{"mode":"classic"}',
            ),
        },
        {
          name: "oversized-header",
          send: () =>
            raw(port, "GET", "/api/v1/health", {
              host: `127.0.0.1:${port}`,
              "x-junk": "a".repeat(64 * 1024),
            }),
        },
        {
          name: "unknown-route",
          send: () => raw(port, "GET", "/api/v1/does-not-exist", { host: `127.0.0.1:${port}` }),
        },
        {
          name: "invalid-move-payload",
          send: () =>
            raw(
              port,
              "POST",
              `/api/v1/games/${g.json.game.id}/moves`,
              { ...base, "content-type": "application/json" },
              '{"commandId":"x","expectedRevision":-1,"direction":"sideways"}',
            ),
        },
      ];

      const slowStart = performance.now();
      const slow = Promise.all([
        ...Array.from({ length: SLOW_SOCKETS / 2 }, () =>
          slowSocket(
            port,
            `GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`,
            "X-Slow: " + "z".repeat(200),
          ),
        ),
        ...Array.from({ length: SLOW_SOCKETS / 2 }, () =>
          slowSocket(
            port,
            `POST /api/v1/games HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nX-CSRF-Token: ${csrf}\r\nContent-Type: application/json\r\nContent-Length: 60000\r\n\r\n`,
            "{".repeat(200),
          ),
        ),
      ]);
      const readers = bigAsset
        ? Promise.all(Array.from({ length: 10 }, () => pausedReader(port, bigAsset, 20_000)))
        : Promise.resolve([]);

      const results: (Raw & { kind: string })[] = [];
      let next = 0;
      const worker = async () => {
        while (next < FLOOD) {
          const k = kinds[next++ % kinds.length] as (typeof kinds)[number];
          results.push({ kind: k.name, ...(await k.send()) });
        }
      };
      const f0 = performance.now();
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      const floodMs = performance.now() - f0;
      const slowResults = await slow;
      await readers;
      const slowElapsed = performance.now() - slowStart;
      polling = false;
      await healthLoop;
      const aliveAfter =
        (await raw(port, "GET", "/api/v1/health", { host: `127.0.0.1:${port}` })).status === 200;

      const byKind: Record<string, Record<string, number>> = {};
      for (const r of results) {
        const key = r.status === null ? `no-response:${r.error ?? ""}`.slice(0, 60) : String(r.status);
        byKind[r.kind] ??= {};
        (byKind[r.kind] as Record<string, number>)[key] =
          ((byKind[r.kind] as Record<string, number>)[key] ?? 0) + 1;
      }
      const fiveXX = results.filter((r) => r.status !== null && r.status >= 500);
      const noResponse = results.filter((r) => r.status === null);
      const oversizeHeaderNoResp = noResponse.filter((r) => r.kind === "oversized-header").length;
      const h = summarize(health);
      const fl = summarize(results.filter((r) => r.status !== null).map((r) => r.ms));
      const slowMax = Math.max(...slowResults.map((s) => s.closedAfterMs));
      return {
        id: "OPS-09",
        title: this.title,
        kind: "partial",
        dataset: `${FLOOD} bad requests (${kinds.length} kinds, round-robin) at concurrency ${CONCURRENCY}; ${SLOW_SOCKETS} slow sockets (${SLOW_SOCKETS / 2} slowloris headers, ${SLOW_SOCKETS / 2} slow bodies); ${bigAsset ? 10 : 0} paused readers of ${bigAsset ?? "(no asset found)"}`,
        warmup: "1 s of /health polling before the flood (included in health samples)",
        rawSampleCount: h.count,
        percentileMethod: PERCENTILE_METHOD,
        metrics: {
          healthLatencyMs: h,
          healthStatusCounts: healthStatus,
          floodResponseMs: fl,
          floodWallMs: Math.round(floodMs),
          floodStatusByKind: byKind,
          slowSockets: {
            maxClosedAfterMs: slowMax,
            closedByServer: slowResults.filter((s) => s.byServer).length,
            total: slowResults.length,
            elapsedMs: Math.round(slowElapsed),
            slowlorisHeadersClosedAfterMs: slowResults.slice(0, SLOW_SOCKETS / 2).map((s) => s.closedAfterMs),
            slowBodyClosedAfterMs: slowResults.slice(SLOW_SOCKETS / 2).map((s) => s.closedAfterMs),
          },
        },
        thresholds: [
          threshold("/health p95 during flood", "< 100 ms (QA target)", h.p95, h.p95 < 100),
          threshold("/health max during flood", "< 1000 ms (QA target)", h.max, h.max < 1000),
          threshold(
            "slow sockets closed by server within",
            "<= 60 s (QA target: app requestTimeout 30 s + slack)",
            slowMax,
            slowMax <= 60_000,
            "Node closes timed-out connections on a periodic check (connectionsCheckingInterval, default 30 s), and headersTimeout defaults to 60 s",
          ),
        ],
        correctness: [
          check("no 5xx for malformed/oversized input", fiveXX.length === 0, `${fiveXX.length} 5xx`),
          check(
            "every flood request answered within the bound (oversized-header may be refused at the socket)",
            noResponse.length === oversizeHeaderNoResp,
            `${noResponse.length} without response (${oversizeHeaderNoResp} oversized-header)`,
          ),
          check(
            "/health always 200",
            Object.keys(healthStatus).every((k) => k === "200"),
            JSON.stringify(healthStatus),
          ),
          check(
            "every slow socket was closed by the server (bounded)",
            slowResults.every((s) => s.byServer),
            `${slowResults.filter((s) => s.byServer).length}/${slowResults.length}`,
          ),
          check(
            "server alive after the flood",
            aliveAfter && server.child.exitCode === null,
            `exit ${server.child.exitCode}`,
          ),
        ],
        notMeasured: ["WebSocket slow consumer and malformed frames (BACKEND-005 not integrated)"],
        notes: [
          "Load generator, slow clients and server share one machine; the server is a separate process.",
        ],
      };
    } finally {
      polling = false;
      await server.stop();
    }
  },
};
