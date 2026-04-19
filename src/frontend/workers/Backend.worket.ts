import { expose } from 'comlink';
import Backend from 'src/backend/backend';

// @ts-ignore
globalThis.window ??= globalThis;

// https://lorefnon.tech/2019/03/24/using-comlink-with-typescript-and-worker-loader/
expose(Backend, self);
