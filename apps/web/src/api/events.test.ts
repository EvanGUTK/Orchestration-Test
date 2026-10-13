import { afterEach, describe, expect, it, vi } from "vitest";
import type { WsEnvelope } from "@g2048/contracts";
import { WebSocketEventStream } from "./events.js";
import type { SocketFactory } from "./events.js";

type FakeSocket = ReturnType<SocketFactory> & { sent: unknown[]; open(): void; message(e: unknown): void };

function fakeFactory() {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = () => {
    const socket: FakeSocket = {
      readyState: 0,
      sent: [],
      send(data: string) {
        this.sent.push(JSON.parse(data));
      },
      close() {
        this.readyState = 3;
        this.onclose?.({});
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      open() {
        this.readyState = 1;
        this.onopen?.({});
      },
      message(e: unknown) {
        this.onmessage?.({ data: JSON.stringify(e) });
      },
    };
    sockets.push(socket);
    return socket;
  };
  return { sockets, factory };
}

const env = (sequence: number, resourceId = "run-1"): WsEnvelope =>
  ({
    protocolVersion: 1,
    type: "bot.progress",
    resourceId,
    sequence,
    payload: { n: sequence },
  }) as WsEnvelope;

afterEach(() => vi.useRealTimers());

describe("WebSocketEventStream", () => {
  it("subscribes after connecting and ignores duplicate/out-of-order envelopes", () => {
    const { sockets, factory } = fakeFactory();
    const stream = new WebSocketEventStream("ws://127.0.0.1/api/v1/events", factory);
    const seen: number[] = [];
    stream.subscribe("bot-run", "run-1", (e) => seen.push(e.sequence));
    const socket = sockets[0]!;
    socket.open();
    expect(socket.sent).toEqual([
      { type: "subscribe", resource: "bot-run", resourceId: "run-1", lastSequence: 0 },
    ]);
    socket.message(env(1));
    socket.message(env(1));
    socket.message(env(3));
    socket.message(env(2));
    socket.message({ ...env(4), protocolVersion: 99 });
    socket.message(env(5, "other"));
    expect(seen).toEqual([1, 3]);
  });

  it("reconnects with backoff and resubscribes from the last sequence", () => {
    vi.useFakeTimers();
    const { sockets, factory } = fakeFactory();
    const stream = new WebSocketEventStream("ws://x", factory);
    stream.subscribe("bot-run", "run-1", () => undefined);
    sockets[0]!.open();
    sockets[0]!.message(env(4));
    sockets[0]!.close();
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([
      { type: "subscribe", resource: "bot-run", resourceId: "run-1", lastSequence: 4 },
    ]);
  });

  it("unsubscribing the last handler closes the socket and stops reconnecting", () => {
    vi.useFakeTimers();
    const { sockets, factory } = fakeFactory();
    const stream = new WebSocketEventStream("ws://x", factory);
    const off = stream.subscribe("bot-run", "run-1", () => undefined);
    sockets[0]!.open();
    off();
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: "unsubscribe", resourceId: "run-1" });
    vi.advanceTimersByTime(20_000);
    expect(sockets).toHaveLength(1);
  });
});
