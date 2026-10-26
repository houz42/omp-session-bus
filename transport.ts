import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Same-user cross-process transport for omp sessions.
 *
 * A live session owns exactly one Unix socket `<uuid>.sock` inside a private
 * directory; the socket file IS the registry entry and the message endpoint.
 * There is no broker, no metadata file, and no polling. Every operation opens
 * a fresh connection, writes one NDJSON request line, half-closes, and reads
 * exactly one NDJSON reply line:
 *
 *   request  {"type":"info"}
 *            {"type":"send","message":{...Envelope}}
 *   reply    {"type":"info","ok":true,"info":{...PeerInfo}}
 *            {"type":"ack","ok":true,"id":"<message id>"}
 *            {"type":"error","ok":false,"code":"...","message":"..."}
 *
 * A send resolves only after the receiving session's receive callback settled
 * without error; every other outcome rejects. There is no message log, no
 * automatic reply, and no retry: an unacknowledged send is ambiguous by
 * design. The trust boundary is the Unix UID, enforced by a 0700 directory
 * and 0600 sockets.
 */

/** Live endpoint descriptor served to same-user discovery probes. */
export interface PeerInfo {
  id: string;
  sessionId: string;
  name: string;
  cwd: string;
  pid: number;
  state: "idle" | "running";
}

/** A cross-session message. Acceptance means the receive callback settled without error — nothing more. */
export interface Envelope {
  id: string;
  from: string;
  to: string;
  body: string;
  replyTo?: string;
  ts: number;
}

/** Fresh per-request metadata supplied by the owning session. */
export type TransportInfo = Omit<PeerInfo, "id">;

export interface StartOptions {
  directory?: string;
  info: () => TransportInfo;
  receive: (message: Envelope) => void | Promise<void>;
}

export interface SendOptions {
  id?: string;
  replyTo?: string;
  signal?: AbortSignal;
}

/** Maximum UTF-8 byte length of a message body. */
export const MAX_BODY_BYTES = 16384;

const SESSION_PREFIX = "session:";
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_ID_RE = new RegExp(`^${SESSION_PREFIX}${UUID_PATTERN}$`);
const SESSION_FILE_RE = new RegExp(`^${UUID_PATTERN}\\.sock$`);
// One NDJSON line: a fully escaped MAX_BODY_BYTES body (up to 6x) plus envelope fields.
const MAX_FRAME_BYTES = MAX_BODY_BYTES * 6 + 4096;
const OP_TIMEOUT_MS = 5000;
const MAX_ID_BYTES = 256;
const MAX_INFO_BYTES = 4096;
const MAX_INBOUND_CONNECTIONS = 32;
const MAX_PROBE_CONCURRENCY = 8;

/** A protocol violation detected while serving an inbound request. */
class FrameError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FrameError";
    this.code = code;
  }
}

/** A client-side request failure with a machine-readable kind. */
class RequestError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = "RequestError";
    this.kind = kind;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBoundedString = (value: unknown): value is string =>
  typeof value === "string" && Buffer.byteLength(value) <= MAX_INFO_BYTES;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function errorCode(error: unknown): string | undefined {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function errorReply(
  code: string,
  message: string,
): { type: "error"; ok: false; code: string; message: string } {
  return { type: "error", ok: false, code, message };
}

function writeFrame(sock: Socket, payload: unknown): void {
  if (sock.destroyed || !sock.writable) return;
  sock.write(`${JSON.stringify(payload)}\n`);
}

function defaultDirectory(): string {
  const custom = process.env.OMP_SESSION_BUS_DIR;
  if (typeof custom === "string" && custom.length > 0) return custom;
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (typeof runtime === "string" && runtime.length > 0)
    return join(runtime, "omp-session-bus");
  const uid = currentUid();
  return join(
    tmpdir(),
    uid === undefined ? "omp-session-bus" : `omp-session-bus-${uid}`,
  );
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(
      `cannot create the session directory ${directory}: ${errorText(error)}`,
    );
  }
  const stats = await lstat(directory);
  if (stats.isSymbolicLink())
    throw new Error(
      `the session directory ${directory} is a symlink; refusing to use it`,
    );
  if (!stats.isDirectory()) throw new Error(`${directory} is not a directory`);
  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(
      `the session directory ${directory} is owned by uid ${stats.uid}, not by the current user; refusing to use it`,
    );
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `the session directory ${directory} permits group or other access (mode ${(stats.mode & 0o777).toString(8)}); refusing to use it`,
    );
  }
}

/** Enforce the private-filesystem boundary before dialing out: sockets must be ours and 0600-clean. */
async function assertSafeSocket(socketPath: string): Promise<void> {
  const stats = await lstat(socketPath).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT")
      throw new RequestError("offline", `no socket at ${socketPath}`);
    throw error;
  });
  if (!stats.isSocket()) throw new Error(`${socketPath} is not a Unix socket`);
  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(
      `${socketPath} is owned by uid ${stats.uid}, not by the current user`,
    );
  }
  if ((stats.mode & 0o077) !== 0)
    throw new Error(`${socketPath} permits group or other access`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    const fallback = setTimeout(resolve, 1000);
    fallback.unref();
    server.close(() => {
      clearTimeout(fallback);
      resolve();
    });
  });
}

async function unlinkQuiet(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Our endpoint is gone either way; a leftover file only makes discovery skip it.
  }
}

/** Race a promise against a deadline; the losing promise keeps running but its result is ignored. */
function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function mapBounded<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  signal: AbortSignal | undefined,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        if (signal?.aborted) throw abortError("operation cancelled");
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

/** One connection, one request line, one reply line, one 5-second budget, no retry. */
function requestOnce(
  socketPath: string,
  requestLine: string,
  signal: AbortSignal | undefined,
  track: Set<Socket>,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      sock.destroy();
      reject(error);
    }
    function succeed(value: unknown): void {
      if (settled) return;
      settled = true;
      cleanup();
      sock.destroy();
      resolve(value);
    }
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      track.delete(sock);
    }
    const sock = connect({ path: socketPath });
    track.add(sock);
    let settled = false;
    let gotLine = false;
    let buffer: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      fail(
        new RequestError(
          "timeout",
          `no reply within ${OP_TIMEOUT_MS / 1000} seconds from ${socketPath}`,
        ),
      );
    }, OP_TIMEOUT_MS);
    timer.unref();
    const onAbort = (): void => fail(abortError("operation cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    sock.on("error", (error: Error) => {
      const code = errorCode(error);
      if (code === "ECONNREFUSED" || code === "ENOENT") {
        fail(
          new RequestError(
            "offline",
            code === "ECONNREFUSED"
              ? `no live endpoint at ${socketPath} (connection refused)`
              : `no socket at ${socketPath}`,
          ),
        );
      } else {
        fail(
          new RequestError(
            "connection",
            `connection to ${socketPath} failed: ${errorText(error)}`,
          ),
        );
      }
    });
    sock.on("close", () => {
      fail(
        new RequestError(
          "closed",
          `the endpoint at ${socketPath} closed the connection without replying`,
        ),
      );
    });
    sock.on("connect", () => {
      sock.write(requestLine);
      sock.end();
    });
    const deliver = (line: Buffer): void => {
      if (line.length > MAX_FRAME_BYTES) {
        fail(
          new RequestError(
            "invalid_reply",
            "reply frame exceeds the byte limit",
          ),
        );
        return;
      }
      gotLine = true;
      try {
        succeed(JSON.parse(line.toString("utf8")));
      } catch {
        fail(
          new RequestError(
            "invalid_reply",
            `the reply from ${socketPath} is not valid JSON`,
          ),
        );
      }
    };
    sock.on("data", (chunk: Buffer) => {
      if (gotLine || settled) return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline !== -1) {
        deliver(buffer.subarray(0, newline));
        return;
      }
      if (buffer.length > MAX_FRAME_BYTES) {
        gotLine = true;
        fail(
          new RequestError(
            "invalid_reply",
            `the reply from ${socketPath} exceeds ${MAX_FRAME_BYTES} bytes`,
          ),
        );
      }
    });
    // EOF without a trailing newline still delimits the final reply line.
    sock.on("end", () => {
      if (gotLine || settled || buffer.length === 0) return;
      deliver(buffer);
    });
    if (signal?.aborted) onAbort();
  });
}

/** Validate and normalize an inbound envelope. Only known fields survive; extras are dropped. */
function parseEnvelope(raw: unknown, ownId: string): Envelope {
  if (!isRecord(raw))
    throw new FrameError(
      "invalid_message",
      "the message must be a JSON object",
    );
  const { id, from, to, body, replyTo, ts } = raw;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    Buffer.byteLength(id) > MAX_ID_BYTES
  ) {
    throw new FrameError(
      "invalid_message",
      "the message id must be a non-empty string of at most 256 bytes",
    );
  }
  if (typeof from !== "string" || !SESSION_ID_RE.test(from)) {
    throw new FrameError(
      "invalid_message",
      "the message sender must be a session:<uuid> address",
    );
  }
  if (typeof to !== "string" || !SESSION_ID_RE.test(to)) {
    throw new FrameError(
      "invalid_message",
      "the message recipient must be a session:<uuid> address",
    );
  }
  if (to !== ownId) {
    throw new FrameError(
      "wrong_recipient",
      `this endpoint only accepts messages addressed to ${ownId}`,
    );
  }
  if (
    typeof body !== "string" ||
    !body.trim() ||
    Buffer.byteLength(body) > MAX_BODY_BYTES
  ) {
    throw new FrameError(
      "invalid_message",
      `the message body must be non-blank and at most ${MAX_BODY_BYTES} UTF-8 bytes`,
    );
  }
  if (
    replyTo !== undefined &&
    (typeof replyTo !== "string" ||
      replyTo.length === 0 ||
      Buffer.byteLength(replyTo) > MAX_ID_BYTES)
  ) {
    throw new FrameError(
      "invalid_message",
      "the message replyTo must be a non-empty string of at most 256 bytes",
    );
  }
  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    throw new FrameError(
      "invalid_message",
      "the message ts must be a finite number",
    );
  }
  return replyTo === undefined
    ? { id, from, to, body, ts }
    : { id, from, to, body, replyTo, ts };
}

/** Validate the info payload of a peer reply; the claimed id must match the socket it answered on. */
function parsePeerInfo(raw: unknown, expectedId: string): PeerInfo | null {
  if (!isRecord(raw) || raw.id !== expectedId) return null;
  const { sessionId, name, cwd, pid, state } = raw;
  if (
    !isBoundedString(sessionId) ||
    !isBoundedString(name) ||
    !isBoundedString(cwd)
  )
    return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 0) return null;
  if (state !== "idle" && state !== "running") return null;
  return { id: expectedId, sessionId, name, cwd, pid, state };
}

/** Validate our own callback's fresh metadata before serving or listing it. */
function validateSelfInfo(raw: unknown, source: string): TransportInfo {
  if (!isRecord(raw))
    throw new Error(`${source} must return a PeerInfo-shaped object`);
  const { sessionId, name, cwd, pid, state } = raw;
  if (!isBoundedString(sessionId))
    throw new Error(`${source} returned an invalid sessionId`);
  if (!isBoundedString(name))
    throw new Error(`${source} returned an invalid name`);
  if (!isBoundedString(cwd))
    throw new Error(`${source} returned an invalid cwd`);
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 0)
    throw new Error(`${source} returned an invalid pid`);
  if (state !== "idle" && state !== "running") {
    throw new Error(
      `${source} returned an invalid state; expected "idle" or "running"`,
    );
  }
  return { sessionId, name, cwd, pid, state };
}

export class SessionTransport {
  readonly id: string;
  readonly directory: string;
  #uuid: string;
  #socketPath: string;
  #server: Server;
  #info: () => TransportInfo;
  #receive: (message: Envelope) => void | Promise<void>;
  #inbound = new Set<Socket>();
  #outbound = new Set<Socket>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    id: string,
    directory: string,
    uuid: string,
    socketPath: string,
    server: Server,
    info: () => TransportInfo,
    receive: (message: Envelope) => void | Promise<void>,
  ) {
    this.id = id;
    this.directory = directory;
    this.#uuid = uuid;
    this.#socketPath = socketPath;
    this.#server = server;
    this.#info = info;
    this.#receive = receive;
    // Transient accept errors must never crash the host process; the endpoint stays up.
    server.on("error", () => {});
  }

  static async start(options: StartOptions): Promise<SessionTransport> {
    if (!isRecord(options))
      throw new Error(
        "start requires an options object with info and receive callbacks",
      );
    const { info, receive } = options;
    if (typeof info !== "function")
      throw new Error("start requires an info callback");
    if (typeof receive !== "function")
      throw new Error("start requires a receive callback");
    const requested = options.directory;
    if (
      requested !== undefined &&
      (typeof requested !== "string" || requested.length === 0)
    ) {
      throw new Error("options.directory must be a non-empty path");
    }
    const directory = resolve(
      requested === undefined ? defaultDirectory() : requested,
    );
    await ensureSafeDirectory(directory);
    const uuid = randomUUID();
    const socketPath = join(directory, `${uuid}.sock`);
    const server = createServer({ allowHalfOpen: true });
    const transport = new SessionTransport(
      `${SESSION_PREFIX}${uuid}`,
      directory,
      uuid,
      socketPath,
      server,
      info,
      receive,
    );
    server.on("connection", (sock: Socket) => transport.#onConnection(sock));
    let bound = false;
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onListenError = (error: Error): void => rejectListen(error);
        server.on("error", onListenError);
        server.listen({ path: socketPath }, () => {
          bound = true;
          server.off("error", onListenError);
          resolveListen();
        });
      });
      await chmod(socketPath, 0o600);
      const stats = await lstat(socketPath);
      if (!stats.isSocket())
        throw new Error("the endpoint did not create a Unix socket");
      if ((stats.mode & 0o777) !== 0o600)
        throw new Error("the endpoint socket has an unsafe mode");
    } catch (error) {
      transport.#closed = true;
      await closeServer(server);
      // Only our own freshly bound socket is ever unlinked; foreign files are untouchable.
      if (bound) await unlinkQuiet(socketPath);
      throw new Error(
        `cannot start the session bus endpoint ${SESSION_PREFIX}${uuid}: ${errorText(error)}`,
      );
    }
    return transport;
  }

  /** Live endpoints only: self plus every socket that answers an info probe. Unreachable peers are skipped, never unlinked. */
  async list(signal?: AbortSignal): Promise<PeerInfo[]> {
    if (this.#closed) throw new Error("the session bus endpoint is closed");
    if (signal?.aborted)
      throw abortError("listing cancelled before it started");
    const self: PeerInfo = {
      id: this.id,
      ...validateSelfInfo(this.#info(), "the info callback"),
    };
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      throw new Error(
        `cannot read the session directory ${this.directory}: ${errorText(error)}`,
      );
    }
    const uuids = names
      .filter((name) => SESSION_FILE_RE.test(name))
      .map((name) => name.slice(0, -".sock".length))
      .filter((uuid) => uuid !== this.#uuid);
    const found = await mapBounded(
      uuids,
      MAX_PROBE_CONCURRENCY,
      async (uuid) => {
        try {
          const socketPath = join(this.directory, `${uuid}.sock`);
          await assertSafeSocket(socketPath);
          const reply = await requestOnce(
            socketPath,
            `${JSON.stringify({ type: "info" })}\n`,
            signal,
            this.#outbound,
          );
          if (!isRecord(reply) || reply.type !== "info" || reply.ok !== true)
            return null;
          return parsePeerInfo(reply.info, `${SESSION_PREFIX}${uuid}`);
        } catch {
          // Refused, unreachable, unsafe, or garbage peers are skipped, never unlinked.
          return null;
        }
      },
      signal,
    );
    if (this.#closed)
      throw new Error("the session bus endpoint closed during discovery");
    const peers = found.filter((peer): peer is PeerInfo => peer !== null);
    return [self, ...peers].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }

  /** Deliver one message; resolves with the envelope only after the receiver's callback accepted it. */
  async send(
    to: string,
    body: string,
    options?: SendOptions,
  ): Promise<Envelope> {
    if (this.#closed) throw new Error("the session bus endpoint is closed");
    if (
      options !== undefined &&
      (typeof options !== "object" ||
        options === null ||
        Array.isArray(options))
    )
      throw new Error("options must be an object");
    const { id = randomUUID(), replyTo, signal } = options ?? {};
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      Buffer.byteLength(id) > MAX_ID_BYTES
    ) {
      throw new Error(
        "options.id must be a non-empty string of at most 256 bytes",
      );
    }
    if (
      replyTo !== undefined &&
      (typeof replyTo !== "string" ||
        replyTo.length === 0 ||
        Buffer.byteLength(replyTo) > MAX_ID_BYTES)
    ) {
      throw new Error(
        "options.replyTo must be a non-empty string of at most 256 bytes",
      );
    }
    if (typeof to !== "string" || !SESSION_ID_RE.test(to)) {
      throw new Error(
        `invalid session address ${JSON.stringify(to)}; expected session:<uuid> with lowercase hex`,
      );
    }
    if (to === this.id)
      throw new Error("cannot send to your own session address");
    if (
      typeof body !== "string" ||
      !body.trim() ||
      Buffer.byteLength(body) > MAX_BODY_BYTES
    ) {
      throw new Error(
        `the message body must be non-blank and at most ${MAX_BODY_BYTES} UTF-8 bytes`,
      );
    }
    if (signal?.aborted) throw abortError("send cancelled before delivery");
    const envelope: Envelope =
      replyTo === undefined
        ? { id, from: this.id, to, body, ts: Date.now() }
        : { id, from: this.id, to, body, replyTo, ts: Date.now() };
    const socketPath = join(
      this.directory,
      `${to.slice(SESSION_PREFIX.length)}.sock`,
    );
    let reply: unknown;
    try {
      await assertSafeSocket(socketPath);
      reply = await requestOnce(
        socketPath,
        `${JSON.stringify({ type: "send", message: envelope })}\n`,
        signal,
        this.#outbound,
      );
    } catch (error) {
      throw this.#sendError(to, error);
    }
    if (this.#closed)
      throw new Error(
        "the session bus endpoint closed before the reply arrived; delivery is ambiguous",
      );
    if (
      isRecord(reply) &&
      reply.type === "ack" &&
      reply.ok === true &&
      typeof reply.id === "string" &&
      reply.id === id
    ) {
      return envelope;
    }
    if (
      isRecord(reply) &&
      reply.type === "error" &&
      reply.ok === false &&
      typeof reply.code === "string" &&
      typeof reply.message === "string"
    ) {
      throw new Error(
        `target session ${to} rejected the message (${reply.code}): ${reply.message}`,
      );
    }
    throw new Error(`target session ${to} sent an invalid reply`);
  }

  /** Idempotent shutdown: settles every connection and removes only this endpoint's own socket. */
  close(): Promise<void> {
    this.#closePromise ??= this.#closeNow();
    return this.#closePromise;
  }

  #sendError(to: string, error: unknown): Error {
    if (this.#closed) {
      return new Error(
        "the session bus endpoint closed before the message was acknowledged; delivery is ambiguous",
      );
    }
    if (error instanceof RequestError) {
      if (error.kind === "offline")
        return new Error(
          `target session ${to} is not reachable; it may be offline (use list to see live sessions)`,
        );
      if (error.kind === "timeout") {
        return new Error(
          `target session ${to} did not acknowledge within ${OP_TIMEOUT_MS / 1000} seconds; delivery is ambiguous, do not resend automatically`,
        );
      }
      if (error.kind === "closed") {
        return new Error(
          `target session ${to} closed the connection before acknowledging; delivery is ambiguous, do not resend automatically`,
        );
      }
      if (error.kind === "aborted")
        return abortError("send cancelled before the peer acknowledged");
      return new Error(`sending to ${to} failed: ${error.message}`);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  async #closeNow(): Promise<void> {
    this.#closed = true;
    for (const sock of [...this.#outbound]) sock.destroy();
    for (const sock of [...this.#inbound]) sock.destroy();
    await closeServer(this.#server);
    await unlinkQuiet(this.#socketPath);
  }

  #onConnection(sock: Socket): void {
    if (this.#closed || this.#inbound.size >= MAX_INBOUND_CONNECTIONS) {
      sock.on("error", () => {
        sock.destroy();
      });
      if (!this.#closed) {
        writeFrame(
          sock,
          errorReply(
            "overloaded",
            `more than ${MAX_INBOUND_CONNECTIONS} concurrent connections`,
          ),
        );
      }
      sock.end();
      const reaper = setTimeout(() => sock.destroy(), 1000);
      reaper.unref();
      sock.on("close", () => clearTimeout(reaper));
      return;
    }
    this.#inbound.add(sock);
    let consumed = false;
    let buffer: Buffer = Buffer.alloc(0);
    const deadlineAt = Date.now() + OP_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (!consumed)
        writeFrame(
          sock,
          errorReply(
            "timeout",
            `no complete request within ${OP_TIMEOUT_MS / 1000} seconds`,
          ),
        );
      sock.destroy();
    }, OP_TIMEOUT_MS);
    timer.unref();
    sock.on("error", () => {
      sock.destroy();
    });
    sock.on("close", () => {
      clearTimeout(timer);
      this.#inbound.delete(sock);
    });
    const processLine = (line: Buffer): void => {
      consumed = true;
      if (line.length > MAX_FRAME_BYTES) {
        writeFrame(
          sock,
          errorReply(
            "frame_too_large",
            `the request line exceeds ${MAX_FRAME_BYTES} bytes`,
          ),
        );
        sock.end();
        return;
      }
      let request: unknown;
      try {
        request = JSON.parse(line.toString("utf8"));
      } catch {
        writeFrame(
          sock,
          errorReply("invalid_frame", "the request line is not valid JSON"),
        );
        sock.end();
        return;
      }
      void this.#serve(sock, request, deadlineAt).catch(() => {
        sock.destroy();
      });
    };
    sock.on("data", (chunk: Buffer) => {
      if (consumed) return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline !== -1) {
        processLine(buffer.subarray(0, newline));
        return;
      }
      if (buffer.length > MAX_FRAME_BYTES) processLine(buffer);
    });
    // EOF without a trailing newline still delimits the final request line.
    sock.on("end", () => {
      if (!consumed && buffer.length > 0) processLine(buffer);
    });
  }

  async #serve(
    sock: Socket,
    request: unknown,
    deadlineAt: number,
  ): Promise<void> {
    const respond = (payload: unknown): void => {
      writeFrame(sock, payload);
      sock.end();
    };
    try {
      if (!isRecord(request)) {
        respond(
          errorReply("invalid_frame", "the request must be a JSON object"),
        );
        return;
      }
      if (request.type === "info") {
        const info = validateSelfInfo(this.#info(), "the info callback");
        respond({ type: "info", ok: true, info: { id: this.id, ...info } });
        return;
      }
      if (request.type === "send") {
        const envelope = parseEnvelope(request.message, this.id);
        const remaining = Math.max(0, deadlineAt - Date.now());
        await withDeadline(
          Promise.resolve(this.#receive(envelope)),
          remaining,
          () =>
            new FrameError(
              "receive_failed",
              `the receive callback did not settle within ${remaining} ms`,
            ),
        );
        respond({ type: "ack", ok: true, id: envelope.id });
        return;
      }
      respond(
        errorReply(
          "invalid_frame",
          `unsupported request type ${JSON.stringify(request.type)}`,
        ),
      );
    } catch (error) {
      if (error instanceof FrameError) {
        respond(errorReply(error.code, error.message));
        return;
      }
      const isInfo = isRecord(request) && request.type === "info";
      respond(
        errorReply(
          isInfo ? "info_failed" : "receive_failed",
          `${isInfo ? "the info callback" : "the receive callback"} failed: ${errorText(error)}`,
        ),
      );
    }
  }
}
