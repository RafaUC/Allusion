import { Remote, wrap } from 'comlink';
import BackupScheduler from 'src/backend/backup-scheduler';

export class BackupSchedulerService {
  worker!: Remote<BackupScheduler>;
  workerInstance?: Worker;
  private initialized = false;

  async init(
    databasePath: string,
    batabaseDirectory: string,
    backupDirectory: string,
  ): Promise<{ backupScheduler: Remote<BackupScheduler>; tempJsonToImport?: string }> {
    if (this.initialized) {
      console.warn('BackupSchedulerService: Already initialized');
      return { backupScheduler: this.worker };
    }

    console.log('BackupSchedulerService: Creating worker...');

    const worker = new Worker(
      new URL('src/frontend/workers/BackupScheduler.worker', import.meta.url),
      {
        type: 'module',
      },
    );
    const WorkerClass = wrap<typeof BackupScheduler>(worker);

    this.worker = await new WorkerClass();
    this.workerInstance = worker;

    console.log('BackupSchedulerService: Initializing worker...');
    const tempJsonToImport = await this.worker.init(
      databasePath,
      batabaseDirectory,
      backupDirectory,
    );
    console.log('tempJsonToImport:', tempJsonToImport);

    this.initialized = true;
    console.log('BackupSchedulerService: Ready!');

    return { backupScheduler: this.worker, tempJsonToImport };
  }
}
