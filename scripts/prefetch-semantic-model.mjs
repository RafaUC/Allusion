#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { AutoModel, AutoTokenizer, env, pipeline, SiglipTextModel } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/siglip-base-patch16-224';
const projectRoot = process.cwd();
const cacheDir = path.resolve(projectRoot, 'resources', 'semantic-model-cache');
const modelCachePath = path.resolve(cacheDir, MODEL_ID);

async function main() {
  fs.mkdirSync(cacheDir, { recursive: true });

  env.allowLocalModels = true;
  env.allowRemoteModels = true;
  env.useBrowserCache = false;
  env.useFSCache = true;
  env.cacheDir = cacheDir;

  console.log(`[semantic-prefetch] cacheDir=${cacheDir}`);
  try {
    await prefetchPipelines();
  } catch (error) {
    if (!shouldRepairCorruptedModelCache(error)) {
      throw error;
    }

    console.warn('[semantic-prefetch] detected corrupted cache, retrying after cleanup...');
    fs.rmSync(modelCachePath, { recursive: true, force: true });
    await prefetchPipelines();
  }

  console.log('[semantic-prefetch] done');
}

async function prefetchPipelines() {
  const modelOptions = { dtype: 'q8' };
  console.log(`[semantic-prefetch] downloading/loading ${MODEL_ID} tokenizer...`);
  await AutoTokenizer.from_pretrained(MODEL_ID);

  console.log(`[semantic-prefetch] downloading/loading ${MODEL_ID} text model...`);
  await loadSiglipTextModel(MODEL_ID, modelOptions);

  console.log(`[semantic-prefetch] downloading/loading ${MODEL_ID} image pipeline...`);
  await pipeline('image-feature-extraction', MODEL_ID, modelOptions);
}

async function loadSiglipTextModel(modelId, modelOptions) {
  if (typeof SiglipTextModel?.from_pretrained === 'function') {
    return SiglipTextModel.from_pretrained(modelId, modelOptions);
  }

  // Fallback for transformer builds without a direct SiglipTextModel export.
  return AutoModel.from_pretrained(modelId, modelOptions);
}

function shouldRepairCorruptedModelCache(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes('protobuf parsing failed') || message.includes('unexpected end of data');
}

try {
  await main();
} catch (error) {
  console.error('[semantic-prefetch] failed', error);
  process.exitCode = 1;
}
