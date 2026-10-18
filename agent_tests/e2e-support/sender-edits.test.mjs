import assert from "node:assert/strict";
import test from "node:test";

import { runSenderHarness as runPlaintext } from "./plaintext-sender.mjs";
import { runSenderHarness as runEncrypted } from "./encrypted-sender.mjs";

for (const encrypted of [false, true]) {
  for (const threadMode of [false, true]) {
    test(
      `${encrypted ? "encrypted" : "plaintext"} ${threadMode ? "thread" : "room"} sender accepts final edits and verifies the original wire type`,
      { timeout: 2000 },
      async (t) => {
        const previous = process.argv;
        t.after(() => {
          process.argv = previous;
        });
        process.argv = [
          "node",
          "sender",
          "--environment",
          "/fixture/environment",
          "--prompt",
          "prompt",
          "--expect",
          "final",
        ];
        if (threadMode) process.argv.push("--thread-root", "$root", "--expect-fallback", "$root");
        const content = (body) => ({
          msgtype: "m.text",
          body,
          ...(threadMode
            ? {
                "m.relates_to": {
                  rel_type: "m.thread",
                  event_id: "$root",
                  "m.in_reply_to": { event_id: "$root" },
                  is_falling_back: true,
                },
              }
            : {}),
        });
        const prompt = {
          event_id: "$prompt",
          eventId: "$prompt",
          sender: "sender",
          content: content("prompt"),
        };
        const original = { event_id: "$original", eventId: "$original", sender: "bridge", content: content("prefix") };
        const edit = {
          event_id: "$edit",
          eventId: "$edit",
          sender: "bridge",
          content: {
            body: "* final",
            msgtype: "m.text",
            "m.new_content": content("final"),
            "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
          },
        };
        const type = encrypted ? "m.room.encrypted" : "m.room.message";
        const wire = new Map([prompt, original, edit].map((event) => [event.event_id, { ...event, type }]));
        let syncs = 0;
        const lookedUp = [];
        t.mock.method(globalThis, "fetch", async (url) => {
          const path = new URL(url).pathname;
          let result;
          if (path.endsWith("/sync")) {
            syncs++;
            assert.ok(syncs <= 3, "final replacement was not recognized");
            result = {
              next_batch: String(syncs),
              rooms: {
                join: { room: { timeline: { events: syncs === 2 ? [wire.get("$original"), wire.get("$edit")] : [] } } },
              },
            };
          } else if (path.includes("/send/")) result = { event_id: "$prompt" };
          else {
            const id = decodeURIComponent(path.split("/event/")[1]);
            lookedUp.push(id);
            result = wire.get(id);
          }
          return { ok: true, json: async () => result };
        });
        const environment = {
          homeserver: "https://fixture.invalid",
          roomId: "room",
          bridge: { userId: "bridge" },
          sender: { userId: "sender", tokenFile: "/fixture/token" },
        };
        const options = {
          readEnvironment: async () => environment,
          readToken: async () => "fixture-token",
          threadMode,
        };
        if (encrypted) {
          t.mock.timers.enable({ apis: ["setTimeout"] });
          let listener;
          const adapter = {
            onFatalError() {},
            onDecryptionFailure() {},
            onSyncBatch(callback) {
              listener = callback;
            },
            async start() {},
            async stop() {},
            async closeCrypto() {},
            async sendMessage() {
              listener({
                phase: "live",
                rooms: [
                  {
                    timeline: [prompt, original, edit].map((event) => ({
                      ...event,
                      isEncrypted: true,
                      isDecrypted: true,
                      isPlaintext: false,
                    })),
                  },
                ],
              });
            },
          };
          const run = runEncrypted({ ...options, createAdapter: async () => adapter });
          await new Promise((resolve) => setImmediate(resolve));
          t.mock.timers.tick(180_000);
          await run;
        } else await runPlaintext(options);
        assert.ok(lookedUp.includes("$original"), "original wire type was not verified");
        assert.ok(lookedUp.includes("$edit"), "replacement wire type was not verified");
      },
    );
  }
}
