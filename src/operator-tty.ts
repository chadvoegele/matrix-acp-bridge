import { constants } from "node:fs";
import { promises as fs } from "node:fs";

/** A separately opened operator terminal; ACP stdio is never used here. */
export interface OperatorTty {
  write(text: string): Promise<void>;
  readLine(): Promise<string | undefined>;
  close(): Promise<void>;
}

export interface OperatorTtyFactory {
  open(path?: string): Promise<OperatorTty>;
}

const NOFOLLOW = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;

/** Open the operator terminal independently from ACP's inherited stdio. */
export const defaultOperatorTtyFactory: OperatorTtyFactory = {
  async open(path = "/dev/tty"): Promise<OperatorTty> {
    const handle = await fs.open(path, constants.O_RDWR | NOFOLLOW);
    let closed = false;
    return {
      async write(text: string): Promise<void> {
        if (closed) {
          throw new Error("operator tty is closed");
        }
        await handle.write(text, undefined, "utf8");
      },
      async readLine(): Promise<string | undefined> {
        if (closed) {
          return undefined;
        }
        const bytes: number[] = [];
        const buffer = Buffer.alloc(1);
        while (true) {
          const result = await handle.read(buffer, 0, 1, null);
          if (result.bytesRead === 0) {
            return bytes.length === 0 ? undefined : Buffer.from(bytes).toString("utf8");
          }
          if (buffer[0] === 0x0A) {
            if (bytes.at(-1) === 0x0D) {
              bytes.pop();
            }
            return Buffer.from(bytes).toString("utf8");
          }
          bytes.push(buffer[0]!);
        }
      },
      async close(): Promise<void> {
        if (closed) {
          return;
        }
        closed = true;
        await handle.close();
      },
    };
  },
};
