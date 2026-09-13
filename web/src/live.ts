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

import type { DeviceInfoWire, DevicesStateWire, MachineStateWire, ScaleSnapshotWire, WaterLevelsWire } from './gateway/types.ts';

/** States in which the machine is actually pulling a shot. */
const BREWING_STATES = new Set(['espresso']);

/** Reconnect backoff, capped so it keeps trying without hammering. */
const RETRY_MS = [500, 1000, 2000, 5000, 10_000];

export type ParsedScaleFrame =
  | { kind: 'status'; connected: boolean }
  | { kind: 'snapshot'; snapshot: ScaleSnapshotWire }
  | null;

/** Scale sockets mix status and measurement frames; reject everything else. */
export function parseScaleFrame(value: unknown): ParsedScaleFrame {
  if (typeof value !== 'object' || value === null) return null;
  const frame = value as ScaleSnapshotWire & { status?: unknown };
  if (frame.status === 'connected' || frame.status === 'disconnected') {
    return { kind: 'status', connected: frame.status === 'connected' };
  }
  if (typeof frame.weight !== 'number' || !Number.isFinite(frame.weight)) return null;
  return { kind: 'snapshot', snapshot: frame };
}

export interface DeviceConnections {
  machine: boolean;
  scale: boolean;
}

/** Hardware state comes from /ws/v1/devices, never from socket liveness. */
export function deviceConnections(value: unknown): DeviceConnections | null {
  if (typeof value !== 'object' || value === null) return null;
  const message = value as DevicesStateWire;
  if (!Array.isArray(message.devices)) return null;
  return {
    machine: message.devices.some((device) => device?.type === 'machine' && device.state === 'connected'),
    scale: message.devices.some((device) => device?.type === 'scale' && device.state === 'connected')
  };
}

export interface LiveSample {
  elapsedS: number;
  pressureBar: number;
  flowMlS: number;
  weightG?: number | null;
  weightFlow: number | null;
  targetPressureBar?: number | null;
  targetFlowMlS?: number | null;
  temperatureC?: number | null;
}

export interface LiveShot {
  startedAt: number;
  samples: LiveSample[];
}

export interface LiveHandlers {
  /** Any snapshot, brewing or not — drives the status strip. */
  onSnapshot?(snapshot: MachineStateWire): void;
  onMachineConnectionChange?(connected: boolean): void;
  onScaleSnapshot?(snapshot: ScaleSnapshotWire): void;
  onScaleConnectionChange?(connected: boolean): void;
  onDevices?(devices: readonly DeviceInfoWire[]): void;
  onWaterLevels?(levels: WaterLevelsWire): void;
  onShotStart?(): void;
  onShotSample?(shot: LiveShot): void;
  /** Fired once when the machine leaves a brewing state. */
  onShotEnd?(shot: LiveShot): void;
}

export class LiveMonitor {
  private readonly wsOrigin: string;
  private readonly handlers: LiveHandlers;
  private sockets: WebSocket[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private stopped = false;
  private shot: LiveShot | null = null;
  private latestScale: ScaleSnapshotWire | null = null;

  constructor(wsOrigin: string, handlers: LiveHandlers) {
    this.wsOrigin = wsOrigin;
    this.handlers = handlers;
  }

  start(): void {
    this.stopped = false;
    this.connectMachine();
    this.connectScale();
    this.connectDevices();
    this.connectWaterLevels();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    for (const socket of this.sockets) socket.close();
    this.timers = [];
    this.sockets = [];
  }

  /**
   * Each Decaid stream has its own lifecycle. In particular, the machine and
   * scale sockets remain open while their device is disconnected, so socket
   * state must never be presented as hardware state.
   */
  private connect(path: string, onMessage: (value: unknown) => void, retry = 0): void {
    if (this.stopped) return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(`${this.wsOrigin}${path}`);
    } catch {
      this.scheduleReconnect(path, onMessage, retry);
      return;
    }

    this.sockets.push(socket);
    let nextRetry = retry;

    socket.onopen = () => {
      nextRetry = 0;
    };

    socket.onmessage = (event) => {
      try {
        onMessage(JSON.parse(String(event.data)) as unknown);
      } catch {
        return;
      }
    };

    socket.onclose = () => {
      this.sockets = this.sockets.filter((candidate) => candidate !== socket);
      this.scheduleReconnect(path, onMessage, nextRetry + 1);
    };

    // An error is always followed by a close, so retry is handled there.
    socket.onerror = () => {};
  }

  private scheduleReconnect(path: string, onMessage: (value: unknown) => void, retry: number): void {
    if (this.stopped) return;
    const delay = RETRY_MS[Math.min(retry, RETRY_MS.length - 1)]!;
    const timer = setTimeout(() => {
      this.timers = this.timers.filter((candidate) => candidate !== timer);
      this.connect(path, onMessage, retry);
    }, delay);
    this.timers.push(timer);
  }

  private connectMachine(): void {
    this.connect('/ws/v1/machine/snapshot', (value) => this.ingest(value as MachineStateWire));
  }

  private connectScale(): void {
    this.connect('/ws/v1/scale/snapshot', (value) => {
      const frame = parseScaleFrame(value);
      if (frame?.kind === 'status') {
        if (!frame.connected) this.latestScale = null;
        this.handlers.onScaleConnectionChange?.(frame.connected);
        return;
      }

      if (frame?.kind !== 'snapshot') return;
      this.latestScale = frame.snapshot;
      this.handlers.onScaleConnectionChange?.(true);
      this.handlers.onScaleSnapshot?.(frame.snapshot);
    });
  }

  private connectDevices(): void {
    this.connect('/ws/v1/devices', (value) => {
      const connected = deviceConnections(value);
      if (!connected) return;
      const message = value as DevicesStateWire;
      this.handlers.onDevices?.(message.devices ?? []);
      this.handlers.onMachineConnectionChange?.(connected.machine);
      this.handlers.onScaleConnectionChange?.(connected.scale);
    });
  }

  private connectWaterLevels(): void {
    this.connect('/ws/v1/machine/waterLevels', (value) => {
      if (typeof value !== 'object' || value === null) return;
      const levels = value as WaterLevelsWire;
      if (typeof levels.currentLevel !== 'number' || !Number.isFinite(levels.currentLevel)) return;
      this.handlers.onWaterLevels?.(levels);
    });
  }

  private ingest(snapshot: MachineStateWire): void {
    this.handlers.onMachineConnectionChange?.(true);
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
        weightG: this.latestScale?.weight ?? null,
        weightFlow: this.latestScale?.weightFlow ?? null,
        targetPressureBar: snapshot.targetPressure ?? null,
        targetFlowMlS: snapshot.targetFlow ?? null,
        temperatureC: snapshot.groupTemperature ?? snapshot.mixTemperature ?? null
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
  pressureGoal: number[] | null;
  flowGoal: number[] | null;
  weightG: number[] | null;
  temperatureC: number[] | null;
} {
  const weight = shot.samples.map((s) => s.weightFlow).filter((w): w is number => w !== null);
  const totalWeight = shot.samples.map((s) => s.weightG ?? null).filter((w): w is number => w !== null);
  const pressureGoal = shot.samples.map((s) => s.targetPressureBar ?? null).filter((v): v is number => v !== null);
  const flowGoal = shot.samples.map((s) => s.targetFlowMlS ?? null).filter((v): v is number => v !== null);
  const temperature = shot.samples.map((s) => s.temperatureC ?? null).filter((v): v is number => v !== null);

  return {
    elapsedS: shot.samples.map((s) => s.elapsedS),
    pressureBar: shot.samples.map((s) => s.pressureBar),
    flowMlS: shot.samples.map((s) => s.flowMlS),
    weightFlow: weight.length === shot.samples.length ? weight : null,
    pressureGoal: pressureGoal.length === shot.samples.length ? pressureGoal : null,
    flowGoal: flowGoal.length === shot.samples.length ? flowGoal : null,
    weightG: totalWeight.length === shot.samples.length ? totalWeight : null,
    temperatureC: temperature.length === shot.samples.length ? temperature : null
  };
}
