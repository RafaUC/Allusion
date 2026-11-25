/// <reference types="@jsquash/jxl/emscripten-types" />
import decode, { init } from '@jsquash/jxl/decode';
import { Loader } from './util';

let decoderReady: Promise<unknown> | undefined;

/**
 * Loads the libjxl WebAssembly decoder once per thread (renderer or thumbnail worker), on first use.
 * The .wasm file is fetched from the bundle and instantiated asynchronously: Chromium refuses synchronous
 * instantiation of large modules on the main thread.
 */
export function initJxlDecoder(): Promise<unknown> {
  if (decoderReady === undefined) {
    const wasmUrl = new URL('@jsquash/jxl/codec/dec/jxl_dec.wasm', import.meta.url);
    decoderReady = fetch(wasmUrl)
      .then((res) => res.arrayBuffer())
      .then((bytes) => WebAssembly.compile(bytes))
      .then((module) =>
        init({
          instantiateWasm: (
            imports: WebAssembly.Imports,
            callback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
          ) => {
            WebAssembly.instantiate(module, imports).then((instance) => callback(instance, module));
            return {}; // tells Emscripten the instance arrives asynchronously through the callback
          },
        } as any),
      );
    // Allow a retry on the next file if loading failed
    decoderReady.catch(() => (decoderReady = undefined));
  }
  return decoderReady;
}

/** Decodes a JPEG XL file (first frame for animations) to 8-bit RGBA. */
export async function decodeJxl(buffer: ArrayBuffer): Promise<ImageData> {
  await initJxlDecoder();
  return decode(buffer);
}

class JxlLoader implements Loader {
  init(): Promise<void> {
    // The decoder loads on first use, so a problem with it can't stop Allusion from starting
    return Promise.resolve();
  }

  decode(buffer: Buffer): Promise<ImageData> {
    // Copy into a standalone ArrayBuffer: a Node Buffer may be a view into a larger shared pool
    return decodeJxl(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  }
}

export default JxlLoader;
