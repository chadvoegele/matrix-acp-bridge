import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";

import { promisify } from "node:util";

import { childExit } from "./acp.mjs";
import { repoRoot, writePrivateFile } from "./common.mjs";
import { makeConfig } from "../test_unencrypted_message/lib.mjs";

function stopProcessGroup(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

// A protocol fixture, not a Matrix homeserver or an encryption substitute.
async function startMatrixFixture(root) {
  const certificatePath = join(root, "certificate.pem");
  const keyPath = join(root, "key.pem");
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  const roomId = "!unified:example.org";
  const bridgeUser = "@bridge:example.org";
  const senderUser = "@sender:example.org";
  const events = [];
  const transactions = new Map();
  const unexpected = [];
  const members = [bridgeUser, senderUser].map((userId) => ({
    event_id: `$member-${userId}`,
    type: "m.room.member",
    sender: userId,
    state_key: userId,
    content: { membership: "join" },
  }));
  const server = createServer(
    { key: await readFile(keyPath), cert: await readFile(certificatePath) },
    async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      const path = decodeURIComponent(url.pathname);
      const sender = request.headers.authorization === "Bearer fixture-bridge" ? bridgeUser : senderUser;
      let body = {};
      let status = 200;
      if (path.endsWith("/whoami")) body = { user_id: sender, device_id: sender === bridgeUser ? "BRIDGE" : "SENDER" };
      else if (path.endsWith("/versions")) body = { versions: ["v1.11"] };
      else if (path.endsWith("/capabilities")) body = { capabilities: {} };
      else if (path.endsWith("/rtc/transports")) body = { rtc_transports: [] };
      else if (path.endsWith("/pushrules/"))
        body = { global: { override: [], content: [], room: [], sender: [], underride: [] } };
      else if (path.endsWith("/filter")) body = { filter_id: "fixture-filter" };
      else if (path.endsWith("/joined_rooms")) body = { joined_rooms: [roomId] };
      else if (path.endsWith("/state")) body = members;
      else if (path.endsWith("/sync")) {
        const since = Number(url.searchParams.get("since") ?? events.length);
        if (since >= events.length) await pause(25);
        body = {
          next_batch: String(events.length),
          rooms: {
            join: {
              [roomId]: {
                state: { events: members },
                timeline: { events: events.slice(since), limited: false, prev_batch: "0" },
              },
            },
          },
          account_data: { events: [] },
          presence: { events: [] },
          to_device: { events: [] },
        };
      } else if (path.includes("/send/m.room.message/")) {
        const key = `${sender}/${path}`;
        if (!transactions.has(key)) {
          let input = "";
          for await (const chunk of request) input += chunk;
          const event = {
            event_id: `$event-${events.length}`,
            room_id: roomId,
            type: "m.room.message",
            sender,
            origin_server_ts: Date.now(),
            content: JSON.parse(input),
          };
          events.push(event);
          transactions.set(key, event.event_id);
        }
        body = { event_id: transactions.get(key) };
      } else if (path.includes("/event/")) {
        body = events.find((event) => event.event_id === path.split("/event/")[1]);
        if (!body) {
          body = { errcode: "M_NOT_FOUND" };
          status = 404;
        }
      } else if (path.includes("/typing/") || path.includes("/receipt/") || path.endsWith("/read_markers")) {
        body = {};
      } else if (path.includes("/state/") || path.includes("/account_data/")) {
        body = { errcode: "M_NOT_FOUND" };
        status = 404;
      } else {
        unexpected.push(`${request.method} ${path}`);
        status = 500;
      }
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    roomId,
    bridgeUser,
    senderUser,
    unexpected,
    certificatePath,
    homeserver: `https://127.0.0.1:${server.address().port}`,
  };
}

for (const mode of ["room", "thread"]) {
  test(
    `scripted ACP and real bridge/SDK subprocesses deliver identified ${mode} streams over isolated HTTPS`,
    { timeout: 60_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "matrix-acp-unified-http-"));
      let fixture;
      let child;
      let output = "";
      try {
        fixture = await startMatrixFixture(root);
        const environment = {
          homeserver: fixture.homeserver,
          roomId: fixture.roomId,
          acpCwd: root,
          acpCommand: [process.execPath, join(repoRoot, "agent_tests/e2e-support/scripted-unified-acp.mjs")],
          bridge: {
            userId: fixture.bridgeUser,
            deviceId: "BRIDGE",
            tokenFile: join(root, "bridge-token"),
            stateDir: join(root, "state"),
            configFile: join(root, "bridge.toml"),
          },
          sender: { userId: fixture.senderUser, deviceId: "SENDER", tokenFile: join(root, "sender-token") },
        };
        await writePrivateFile(environment.bridge.tokenFile, "fixture-bridge");
        await writePrivateFile(environment.sender.tokenFile, "fixture-sender");
        await writePrivateFile(
          environment.bridge.configFile,
          makeConfig(environment).replace('response_mode = "room"', `response_mode = "${mode}"`),
        );
        const environmentPath = join(root, "environment.json");
        await writePrivateFile(environmentPath, JSON.stringify(environment));
        child = spawn(process.execPath, [join(repoRoot, "agent_tests/e2e-support/unified-wire.mjs"), environmentPath], {
          cwd: repoRoot,
          env: {
            ...process.env,
            NODE_EXTRA_CA_CERTS: fixture.certificatePath,
            E2E_UNIFIED_TRANSPORT: "plaintext",
            E2E_UNIFIED_RESPONSE_MODE: mode,
          },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          timeout: 55_000,
        });
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        await childExit(child, "unified harness").catch((error) => {
          throw new Error(`${error.message}\n${output}`);
        });
        assert.match(output, /2 streams, stale-session reset and buffered shutdown passed/u);
        assert.deepEqual(fixture.unexpected, []);
      } finally {
        if (child?.pid) {
          stopProcessGroup(child.pid);
        }
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await childExit(child, "unified harness", [143]);
        }
        if (fixture) {
          fixture.server.closeAllConnections();
          await new Promise((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
