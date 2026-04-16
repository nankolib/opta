// Node.js polyfills for browser — imported before anything else
import { Buffer } from "buffer";

window.Buffer = Buffer;
(globalThis as any).Buffer = Buffer;
(globalThis as any).global = globalThis;
(globalThis as any).process = (globalThis as any).process || { env: {} };
