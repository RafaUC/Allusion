import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

async function main() {
  const ffmpegPath = require('ffmpeg-static');
  if (!ffmpegPath || typeof ffmpegPath !== 'string') {
    throw new Error('ffmpeg-static did not provide a binary path for this platform.');
  }

  const ffmpegPackage = require('ffmpeg-static/package.json');
  const executableName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const targetDir = path.resolve(process.cwd(), 'resources', 'ffmpeg');
  const targetPath = path.resolve(targetDir, executableName);
  const versionPath = path.resolve(targetDir, '.version');

  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(ffmpegPath, targetPath);

  const version = ffmpegPackage?.version ? String(ffmpegPackage.version) : 'unknown';
  await fs.writeFile(versionPath, version, 'utf8');

  console.log(`ffmpeg installed: ${targetPath} (${version})`);
}

try {
  await main();
} catch (error) {
  console.error('Failed to prefetch ffmpeg:', error);
  process.exitCode = 1;
}
