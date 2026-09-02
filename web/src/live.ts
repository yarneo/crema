/**
 * The live shot.
 *
 * Decaid pushes complete machine snapshots over a WebSocket. This watches that
 * stream, decides when a shot starts and ends, and accumulates the curves as
 * it goes — so the moment a shot finishes we already have everything the
 * advisor needs, without asking the gateway for it.
 *
 * Reconnection is unconditional: a tablet sleeps, wifi drops, Decaid restarts.
 * A skin that silently stops updating after the first hiccup is worse than one
 * that never worked.
 */

import type { MachineStateWire } from './gateway/types.ts';

/** States in which the machine is actually pulling a shot. */
const BREWING_STATES = new Set(['espresso']);

/** Reconnect backoff, capped so it keeps trying without hammering. */
const RETRY_MS = [500, 1000, 2000, 5000, 10_000];

export interface LiveSample {
  elapsedS: number;
  pressureBar: number;
  flowMlS: number;
  weightFlow: number | null;
}

export interface LiveShot {
  startedAt: number;
  samples: LiveSample[];
}

export interface LiveHandlers {
  /** Any snapshot, brewing or not — drives the status strip. */
  onSnapshot?(snapshot: MachineStateWire): void;
  onShotStart?(): void;
  onShotSample?(shot: LiveShot): void;
  /** Fired once when the machine leaves a brewing state. */
  onShotEnd?(shot: LiveShot): void;
  onConnectionChange?(connected: boolean): void;
}

export class LiveMonitor {
  private readonly wsOrigin: string;
  private readonly handlers: LiveHandlers;
  private socket: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private shot: LiveShot | null = null;

  constructor(wsOrigin: string, handlers: LiveHandlers) {
    this.wsOrigin = wsOrigin;
    this.handlers = handlers;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.stopped) return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(`${this.wsOrigin}/ws/v1/machine/snapshot`);
    } catch {
      this.scheduleRetry();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      this.retry = 0;
      this.handlers.onConnectionChange?.(true);
    };

    socket.onmessage = (event) => {
      let snapshot: MachineStateWire;
      try {
        snapshot = JSON.parse(String(event.data)) as MachineStateWire;
      } catch {
        return; // a frame we cannot read is not worth tearing the socket down
      }
      this.ingest(snapshot);
    };

    socket.onclose = () => {
      this.handlers.onConnectionChange?.(false);
      this.scheduleRetry();
    };

    // An error is always followed by a close, so retry is handled there.
    socket.onerror = () => {};
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)]!;
    this.retry++;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private ingest(snapshot: MachineStateWire): void {
    this.handlers.onSnapshot?.(snapshot);

    const brewing = BREWING_STATES.has(snapshot.state?.state ?? '');

    if (brewing && this.shot === null) {
      this.shot = { startedAt: Date.now(), samples: [] };
      this.handlers.onShotStart?.();
    }

    if (brewing && this.shot !== null) {
      this.shot.samples.push({
        elapsedS: Number(((Date.now() - this.shot.startedAt) / 1000).toFixed(2)),
        pressureBar: snapshot.pressure ?? 0,
        flowMlS: snapshot.flow ?? 0,
        weightFlow: null
      });
      this.handlers.onShotSample?.(this.shot);
      return;
    }

    if (!brewing && this.shot !== null) {
      const finished = this.shot;
      this.shot = null;
      // A stray frame or a flush is not a shot worth rating.
      if (finished.samples.length >= 4) this.handlers.onShotEnd?.(finished);
    }
  }
}

/** Turn accumulated live samples into the curve arrays the advisor wants. */
export function toCurves(shot: LiveShot): {
  elapsedS: number[];
  pressureBar: number[];
  flowMlS: number[];
  weightFlow: number[] | null;
} {
  const weight = shot.samples.map((s) => s.weightFlow).filter((w): w is number => w !== null);

  return {
    elapsedS: shot.samples.map((s) => s.elapsedS),
    pressureBar: shot.samples.map((s) => s.pressureBar),
    flowMlS: shot.samples.map((s) => s.flowMlS),
    weightFlow: weight.length === shot.samples.length ? weight : null
  };
}
