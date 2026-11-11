import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createAcpClient } from "../../src/acp-client.ts";
import { BridgeCoordinator } from "../../src/bridge.ts";
import { openBridgeStateStore } from "../../src/bridge-state.ts";

assert.ok(process.env.PI_ACP_CHECKOUT, "Set PI_ACP_CHECKOUT to an installed pi-acp checkout");
const adapterUrl = pathToFileURL(`${process.env.PI_ACP_CHECKOUT}/`);
const { PiAcpAgent } = await import(new URL("src/acp/agent.ts", adapterUrl));
const { PiAcpSession } = await import(new URL("src/acp/session.ts", adapterUrl));
const { FakePiRpcProcess } = await import(new URL("test/helpers/fakes.ts", adapterUrl));
const ROOM = "!reproduction:example.org";
const ROOT = "$thread-root";
const SESSION = "autonomous-reproduction";
const REQUEST = "Add a concise README";

class TimedBackend {
  history = [];

  requests = [];

  responses = [];

  rejectedPrompts = [];

  busy = false;

  process = new FakePiRpcProcess();

  timers = new Set();

  encoder = new TextEncoder();

  decoder = new TextDecoder();

  buffer = "";

  constructor() {
    this.input = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.output = new WritableStream({
      write: (chunk) => {
        this.buffer += this.decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = this.buffer.indexOf("\n")) !== -1) {
          const frame = JSON.parse(this.buffer.slice(0, newline));
          this.buffer = this.buffer.slice(newline + 1);
          void this.respond(frame);
        }
      },
    });
    const connection = {
      sessionUpdate: async (parameters) => {
        this.send({ jsonrpc: "2.0", method: "session/update", params: parameters });
      },
    };
    this.session = new PiAcpSession({
      sessionId: SESSION,
      cwd: process.cwd(),
      mcpServers: [],
      proc: this.process,
      conn: connection,
      fileCommands: [],
    });
    this.agent = new PiAcpAgent(connection);
    Object.assign(this.agent, { sessions: { maybeGet: () => this.session } });
    this.process.prompt = async (message) => {
      if (this.busy) {
        this.rejectedPrompts.push(message);
        throw new Error(
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
        );
      }
      this.history.push(message);
      this.busy = true;
      this.process.emit({ type: "agent_start" });
      this.schedule(5, () => this.finishTurn());
    };
  }

  schedule(milliseconds, action) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      action();
    }, milliseconds);
    this.timers.add(timer);
  }

  startAutonomousTurn() {
    this.busy = true;
    this.process.emit({ type: "agent_start" });
  }

  finishTurn() {
    this.busy = false;
    this.process.emit({ type: "agent_end" });
    this.process.emit({ type: "agent_settled" });
  }

  send(frame) {
    this.controller.enqueue(this.encoder.encode(`${JSON.stringify(frame)}\n`));
  }

  async respond(frame) {
    this.requests.push(frame);
    let result;
    switch (frame.method) {
      case "initialize": {
        result = await this.agent.initialize(frame.params);
        break;
      }
      case "session/new": {
        result = { sessionId: SESSION };
        break;
      }
      case "session/prompt": {
        result = await this.agent.prompt(frame.params);
        break;
      }
      case "_session/steering": {
        result = await this.agent.extMethod(frame.method, frame.params);
        break;
      }
      default: {
        throw new Error(`Unexpected ACP method: ${frame.method}`);
      }
    }
    this.responses.push(result);
    this.send({ jsonrpc: "2.0", id: frame.id, result });
  }

  close() {
    for (const timer of this.timers) clearTimeout(timer);
  }
}

function noop() {}

function unsubscribe() {
  return noop;
}

function inbound(eventId, body) {
  return {
    eventId,
    roomId: ROOM,
    sender: "@alice:example.org",
    type: "m.room.message",
    content: {
      msgtype: "m.text",
      body,
      ...(eventId === ROOT ? {} : { "m.relates_to": { rel_type: "m.thread", event_id: ROOT } }),
    },
    isLive: true,
    isPlaintext: true,
    isRedacted: false,
    isEncrypted: false,
    isDecrypted: true,
  };
}

function configuration(stateDir) {
  return {
    stateDir,
    matrix: {
      homeserver: "https://matrix.example.org",
      userId: "@bridge:example.org",
      deviceId: "REPRODUCTION",
      accessTokenFile: "/unused",
      allowedRooms: [ROOM],
      allowedSenders: ["@alice:example.org"],
      encryption: "disabled",
      responseMode: "thread",
      defaultMessageDelivery: "steer",
      agentTextFlushBytes: 2048,
      agentTextQuietMs: 750,
      agentTextMaxIntervalMs: 2000,
    },
    acp: { cwd: process.cwd() },
    limits: {
      maxInputBytes: 16_384,
      maxOutputBytes: 262_144,
      maxMatrixMessageBytes: 32_768,
      maxActivityEventsPerMessage: 10,
      maxQueuedTurnsPerConversation: 128,
      maxConcurrentPrompts: 2,
      maxTurnSeconds: 5,
      shutdownGraceSeconds: 1,
      startupTimeoutSeconds: 5,
      initialSyncTimelineLimit: 100,
      maxCatchupAgeSeconds: 900,
      maxCatchupEventsPerRoom: 4,
    },
  };
}

await test(
  "#34: real bridge + real pi-acp falsely complete a prompt rejected during an autonomous turn",
  { timeout: 10_000 },
  async (context) => {
    const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-34-"));
    const config = configuration(stateDir);
    const backend = new TimedBackend();
    const acp = createAcpClient({ cwd: process.cwd(), input: backend.input, output: backend.output });
    const state = await openBridgeStateStore({ stateDir, identity: config.matrix });
    const sent = [];
    const matrix = {
      onFatalError: unsubscribe,
      sendMessage: async (part) => {
        sent.push(part);
      },
      setTyping: async () => {},
      sendReadReceipt: async () => {},
    };
    const bridge = new BridgeCoordinator({ config, acp, matrix, stateStore: state, steering: true });
    try {
      await acp.initialize({ protocolVersion: 1, capabilities: { filesystem: false, terminal: false } });
      const deliver = async (eventId, body) => {
        await bridge.handleTimelineEvent(inbound(eventId, body), async () => {
          await state.markEventCompleted(ROOM, eventId);
        });
      };
      await deliver(ROOT, "seed request");
      assert.deepEqual(backend.history, ["seed request"]);

      backend.startAutonomousTurn();
      assert.equal(backend.session.hasPendingTurn, false);
      assert.deepEqual(await acp.steer(SESSION, REQUEST, 1000), {
        kind: "steering",
        outcome: "promptRequired",
        reason: "noRunningTurn",
      });
      await delay(1);
      await deliver("$lost-readme", REQUEST);
      assert.deepEqual(backend.rejectedPrompts, [REQUEST]);
      assert.deepEqual(backend.history, ["seed request"]);
      assert.deepEqual(backend.responses.at(-1), { stopReason: "end_turn" });
      const disk = JSON.parse(await readFile(join(stateDir, "bridge-state.json"), "utf8"));
      assert.ok(disk.completedEventIds[ROOM].includes("$lost-readme"));
      assert.deepEqual(sent, [], "no failure message reaches Matrix");
      context.diagnostic(
        "REPRODUCED: rejected prompt -> ACP end_turn -> durable completedEventIds; no agent history entry or Matrix error",
      );

      backend.finishTurn();
      await delay(0);
      await deliver("$later", "later request");
      assert.deepEqual(backend.history, ["seed request", "later request"]);
      assert.equal(bridge.fatalError, undefined);
    } finally {
      await bridge.stop();
      await acp.close();
      backend.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  },
);
