import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';

const RELEASE_URL = 'https://api.github.com/repos/sqliteai/sqlite-vector/releases/latest';
const ROOT = process.cwd();
const TARGET_DIR = path.resolve(ROOT, 'resources', 'sqlite-vector');

function getTargetAssetPrefix(platform, arch) {
  if (platform === 'darwin') {
    if (arch === 'arm64') {
      return 'vector-macos-arm64-';
    }
    if (arch === 'x64') {
      return 'vector-macos-x86_64-';
    }
    return 'vector-macos-';
  }

  if (platform === 'linux') {
    if (arch === 'arm64') {
      return 'vector-linux-arm64-';
    }
    if (arch === 'x64') {
      return 'vector-linux-x86_64-';
    }
  }

  if (platform === 'win32' && arch === 'x64') {
    return 'vector-windows-x86_64-';
  }

  throw new Error(`Unsupported platform/arch for sqlite-vector: ${platform}/${arch}`);
}

function getBinaryFileName(platform) {
  if (platform === 'darwin') {
    return 'vector.dylib';
  }
  if (platform === 'linux') {
    return 'vector.so';
  }
  if (platform === 'win32') {
    return 'vector.dll';
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'allusion-sqlite-vector-prefetch',
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed (${response.status}): ${body}`);
  }

  return response.json();
}

async function downloadToBuffer(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'allusion-sqlite-vector-prefetch',
      Accept: 'application/octet-stream',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Download failed (${response.status}): ${body}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function main() {
  const platform = process.platform;
  const arch = process.arch;
  const desiredPrefix = getTargetAssetPrefix(platform, arch);

  const release = await fetchJson(RELEASE_URL);
  const asset = (release.assets ?? []).find(
    (candidate) =>
      typeof candidate?.name === 'string' &&
      candidate.name.startsWith(desiredPrefix) &&
      candidate.name.endsWith('.zip') &&
      typeof candidate.browser_download_url === 'string',
  );

  if (!asset) {
    throw new Error(
      `Could not find sqlite-vector binary asset for ${platform}/${arch} in release ${release.tag_name}.`,
    );
  }

  const expectedBinaryName = getBinaryFileName(platform);
  await fs.mkdir(TARGET_DIR, { recursive: true });

  const versionFile = path.resolve(TARGET_DIR, '.version');
  const targetBinaryPath = path.resolve(TARGET_DIR, expectedBinaryName);
  const existingVersion = await fs.readFile(versionFile, 'utf8').catch(() => '');

  if (existingVersion.trim() === String(release.tag_name)) {
    const exists = await fs
      .stat(targetBinaryPath)
      .then((info) => info.isFile())
      .catch(() => false);
    if (exists) {
      console.log(`sqlite-vector ${release.tag_name} already present at ${targetBinaryPath}`);
      return;
    }
  }

  console.log(`Downloading sqlite-vector ${release.tag_name}: ${asset.name}`);
  const zipBuffer = await downloadToBuffer(asset.browser_download_url);

  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const binaryEntry = entries.find((entry) => {
    if (entry.isDirectory) {
      return false;
    }
    const base = path.basename(entry.entryName).toLowerCase();
    return base === 'vector.dylib' || base === 'vector.so' || base === 'vector.dll' || base === 'vector';
  });

  if (!binaryEntry) {
    throw new Error(`Archive ${asset.name} does not contain a sqlite-vector binary.`);
  }

  const binaryBuffer = binaryEntry.getData();
  await fs.writeFile(targetBinaryPath, binaryBuffer);
  await fs.writeFile(versionFile, String(release.tag_name));

  console.log(`sqlite-vector installed: ${targetBinaryPath}`);
}

try {
  await main();
} catch (error) {
  console.error('Failed to prefetch sqlite-vector:', error);
  process.exitCode = 1;
}
