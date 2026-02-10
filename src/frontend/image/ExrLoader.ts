import { default as init, decode } from 'wasm/packages/exr/exr_decoder';
import { BaseLoader } from './util';

class ExrLoader extends BaseLoader {
  protected async doInit(): Promise<void> {
    await init(new URL('wasm/packages/exr/exr_decoder_bg.wasm', import.meta.url));
  }

  public async decode(buffer: Buffer): Promise<ImageData> {
    await this.ensureReady();
    return decode(buffer);
  }
}

export default ExrLoader;
