/**
 * The Decaid gateway client.
 *
 * Decaid serves an installed skin from port 3000 while its API lives on 8080,
 * so the origin has to be derived rather than assumed same-origin. During
 * `vite dev` the page is on 5173 and the gateway is wherever the developer's
 * machine or tablet is, hence the override.
 *
 * Every call carries a deadline. A gateway that has lost its machine can
 * accept a connection and then never answer, and a skin that hangs on a
 * pending fetch looks broken in a way that is hard to diagnose from a tablet.
 */

import type {
  BeanBatchWire,
  CommandableState,
  BeanWire,
  MachineStateWire,
  ProfileEntryWire,
  ProfileWire,
  ShotPageWire,
  WorkflowPatch,
  WorkflowWire
} from './types.ts';

/** Decaid's API port. The skin itself is served from 3000. */
export const GATEWAY_PORT = 8080;

const DEFAULT_TIMEOUT_MS = 8000;

// Note: fields are declared and assigned explicitly rather than using
// TypeScript parameter properties. Parameter properties emit code, so they are
// rejected by Node's strip-only TypeScript mode — which is what runs our tests
// without a build step. `erasableSyntaxOnly` in tsconfig enforces this.
export class GatewayError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, message: string) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.path = path;
  }
}

export class GatewayTimeoutError extends Error {
  readonly path: string;

  constructor(path: string, timeoutMs: number) {
    super(`${path} did not answer within ${timeoutMs}ms`);
    this.name = 'GatewayTimeoutError';
    this.path = path;
  }
}

export interface LocationLike {
  protocol: string;
  hostname: string;
}

/**
 * Where the gateway is.
 *
 * `override` wins, so a developer can point a laptop at a tablet. Otherwise we
 * keep the page's host and swap to the API port: that works both for a skin
 * Decaid is serving locally and for one loaded across the LAN.
 */
export function resolveGatewayOrigin(location: LocationLike, override?: string | null): string {
  const trimmed = override?.trim();
  if (trimmed) return trimmed.replace(/\/+$/, '');

  // A page on https cannot call http without being blocked, so mirror the
  // page's scheme and let a misconfiguration surface as a clear error.
  const protocol = location.protocol === 'https:' ? 'https:' : 'http:';
  return `${protocol}//${location.hostname}:${GATEWAY_PORT}`;
}

/** WebSocket origin for the same gateway. */
export function toWebSocketOrigin(httpOrigin: string): string {
  return httpOrigin.replace(/^http(s?):/, 'ws$1:');
}

/**
 * Decaid reports failures as a JSON body, not plain text:
 *
 *   HTTP 500 {"error":"DeviceNotConnectedException: machine not connected"}
 *
 * (verified against a live gateway). Unwrap it, and strip the exception class
 * name, which tells a barista nothing. The most common case by far is simply
 * that the machine is asleep or not paired, so say that.
 */
export function describeGatewayError(path: string, status: number, body: string): string {
  let detail = body.trim();

  try {
    const parsed: unknown = JSON.parse(detail);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string') {
      detail = (parsed as { error: string }).error.trim();
    }
  } catch {
    // Not JSON; keep whatever text came back.
  }

  // "DeviceNotConnectedException: machine not connected" -> "machine not connected"
  const withoutClass = detail.replace(/^[A-Za-z.]*Exception:\s*/, '');

  if (/not connected/i.test(withoutClass)) {
    return 'The machine is not connected. Wake the DE1 and check it is paired with Decaid.';
  }

  return withoutClass || `${path} failed with ${status}`;
}

export interface GatewayOptions {
  origin: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class Gateway {
  private readonly origin: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: GatewayOptions) {
    this.origin = options.origin.replace(/\/+$/, '');
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get httpOrigin(): string {
    return this.origin;
  }

  get wsOrigin(): string {
    return toWebSocketOrigin(this.origin);
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.doFetch(`${this.origin}${path}`, { ...init, signal: controller.signal });
    } catch (cause) {
      if ((cause as Error)?.name === 'AbortError') throw new GatewayTimeoutError(path, this.timeoutMs);
      throw new GatewayError(0, path, `Could not reach the gateway: ${(cause as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new GatewayError(response.status, path, describeGatewayError(path, response.status, detail));
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** The current recipe, as the machine has it. */
  readWorkflow(): Promise<WorkflowWire> {
    return this.request<WorkflowWire>('/api/v1/workflow');
  }

  /**
   * Live machine state. Throws when no machine is connected, which is a normal
   * condition rather than a fault — callers show "not connected" and carry on,
   * because the whole dial-in loop still works against stored shots.
   */
  readMachineState(): Promise<MachineStateWire> {
    return this.request<MachineStateWire>('/api/v1/machine/state');
  }

  /**
   * Apply a partial recipe change. Decaid uploads it to the machine and
   * returns the complete updated workflow, which is what we render from — the
   * machine's answer, not our optimistic guess.
   */
  updateWorkflow(patch: WorkflowPatch): Promise<WorkflowWire> {
    return this.request<WorkflowWire>('/api/v1/workflow', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    });
  }

  /** Every profile the gateway knows, each wrapped with its content hash id. */
  readProfiles(): Promise<ProfileEntryWire[]> {
    return this.request<ProfileEntryWire[]>('/api/v1/profiles');
  }

  /**
   * Switch profile.
   *
   * A switch cannot be done by name: the workflow carries the profile's own
   * definition, so selecting one means sending its steps. That is why the
   * recipe diff deliberately leaves profileTitle alone and routes here.
   */
  selectProfile(profile: ProfileWire): Promise<WorkflowWire> {
    return this.updateWorkflow({ profile });
  }

  readBeans(): Promise<BeanWire[]> {
    return this.request<BeanWire[]>('/api/v1/beans');
  }

  /** Roaster and name are the only required fields. */
  createBean(bean: Partial<BeanWire> & { roaster: string; name: string }): Promise<BeanWire> {
    return this.request<BeanWire>('/api/v1/beans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bean)
    });
  }

  /**
   * Command the machine.
   *
   * This actuates real hardware — water moves — so it is only ever called from
   * an explicit button press, never as part of loading a screen.
   */
  setState(state: CommandableState): Promise<void> {
    return this.request<void>(`/api/v1/machine/state/${state}`, { method: 'PUT' });
  }

  readBatches(beanId: string): Promise<BeanBatchWire[]> {
    return this.request<BeanBatchWire[]>(`/api/v1/beans/${encodeURIComponent(beanId)}/batches`);
  }

  /** Record a bag. Roast date is what makes days-off-roast real. */
  createBatch(beanId: string, batch: BeanBatchWire): Promise<BeanBatchWire> {
    return this.request<BeanBatchWire>(`/api/v1/beans/${encodeURIComponent(beanId)}/batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch)
    });
  }

  /**
   * Recent shots. The list omits measurements for speed, so the curves for a
   * single shot need a follow-up read by id.
   */
  readShots(limit = 25): Promise<ShotPageWire> {
    return this.request<ShotPageWire>(`/api/v1/shots?limit=${limit}`);
  }
}
