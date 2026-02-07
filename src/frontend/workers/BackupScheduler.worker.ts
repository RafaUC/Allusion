import { expose } from 'comlink';
import BackupScheduler from 'src/backend/backup-scheduler';

// https://lorefnon.tech/2019/03/24/using-comlink-with-typescript-and-worker-loader/
expose(BackupScheduler, self);
