import { proxy, Remote, wrap } from 'comlink';
import Backend from 'src/backend/backend';

export class BackendService {
  worker!: Remote<Backend>;
  workerInstance?: Worker;
  private initialized = false;

  async init(
    dbPath: string,
    jsonToImport: string | undefined,
    notifyChange: () => void,
    restoreEmpty: () => Promise<void>,
  ): Promise<Remote<Backend> | undefined> {
    if (this.initialized) {
      console.warn('BackendService: Already initialized');
      return this.worker;
    }

    console.log('BackendService: Creating worker...');

    const worker = new Worker(new URL('src/frontend/workers/Backend.worket', import.meta.url), {
      type: 'module',
    });
    const WorkerClass = wrap<typeof Backend>(worker);

    this.worker = await new WorkerClass();
    this.workerInstance = worker;

    console.log('BackendService: Initializing worker backend...');
    await this.worker.init(dbPath, jsonToImport, proxy(notifyChange), proxy(restoreEmpty));

    this.initialized = true;
    console.log('BackendService: Ready!');

    return this.worker;
  }
}
