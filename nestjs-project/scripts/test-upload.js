#!/usr/bin/env node
/**
 * Manual end-to-end smoke test for Phase 03 (Streamtube upload/processing).
 *
 * Exercises the real HTTP flow that has NOT been covered by automated tests yet
 * (see progress.md, SI-03.14 observations):
 *   register -> confirm email (via Mailpit) -> login -> POST /videos
 *   -> sign each part -> PUT each part to MinIO -> complete upload
 *   -> poll GET /videos/:publicId until the worker finishes (ready/failed)
 *
 * Requirements: Node 20+ (uses global fetch), `docker compose up -d` already
 * running (nestjs-api on :3000, mailpit on :8025, minio on :9000).
 *
 * Usage:
 *   node test-upload.js /path/to/video.mp4
 *   node test-upload.js /path/to/video.mp4 --api http://localhost:3000
 */

const fs = require('fs');
const path = require('path');

const API = process.argv.includes('--api')
  ? process.argv[process.argv.indexOf('--api') + 1]
  : 'http://localhost:3000';
const MAILPIT = 'http://localhost:8025';

const filePath = process.argv[2];
if (!filePath || filePath.startsWith('--')) {
  console.error('Usage: node test-upload.js /path/to/video.mp4 [--api http://localhost:3000]');
  process.exit(1);
}
if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const CONTENT_TYPE_BY_EXT = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function json(res) {
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(
      `${res.status} ${res.statusText} — ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    );
  }
  return body;
}

async function registerAndConfirm(email, password) {
  log(`Registering ${email}...`);
  await json(
    await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  );

  log('Waiting for confirmation email in Mailpit...');
  let token = null;
  for (let attempt = 0; attempt < 20 && !token; attempt++) {
    await sleep(500);
    const list = await json(
      await fetch(`${MAILPIT}/api/v1/messages?limit=50`),
    );
    const msg = (list.messages || []).find(
      (m) => m.To?.some((t) => t.Address === email) && /confirm/i.test(m.Subject || ''),
    );
    if (!msg) continue;
    const full = await json(await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`));
    const source = `${full.Text || ''}\n${full.HTML || ''}`;
    const match = source.match(/token=([A-Za-z0-9._-]+)/);
    if (match) token = match[1];
  }
  if (!token) throw new Error('Confirmation email/token not found in Mailpit after 10s');

  log('Confirming email...');
  const confirmRes = await fetch(
    `${API}/auth/confirm-email?token=${encodeURIComponent(token)}`,
  );
  if (!confirmRes.ok) {
    throw new Error(`confirm-email failed: ${confirmRes.status} ${await confirmRes.text()}`);
  }
}

async function login(email, password) {
  log('Logging in...');
  const { access_token } = await json(
    await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  );
  return access_token;
}

async function main() {
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPE_BY_EXT[ext];
  if (!contentType) {
    throw new Error(
      `Unsupported extension "${ext}". Allowed: ${Object.keys(CONTENT_TYPE_BY_EXT).join(', ')}`,
    );
  }

  log(`File: ${filePath} (${(stat.size / 1024 / 1024).toFixed(1)} MiB, ${contentType})`);

  const runId = Date.now();
  const email = `upload-test-${runId}@example.com`;
  const password = 'TestPassword123!';

  await registerAndConfirm(email, password);
  const token = await login(email, password);
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  log('Creating video (POST /videos)...');
  const video = await json(
    await fetch(`${API}/videos`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        filename: path.basename(filePath),
        size_bytes: stat.size,
        content_type: contentType,
      }),
    }),
  );
  log(`Video created: id=${video.id} public_id=${video.public_id}`);
  const { upload_id, part_size_bytes, part_count } = video.upload;
  log(`Upload plan: upload_id=${upload_id} part_size=${part_size_bytes} part_count=${part_count}`);

  const fd = fs.openSync(filePath, 'r');
  const parts = [];
  try {
    for (let partNumber = 1; partNumber <= part_count; partNumber++) {
      const offset = (partNumber - 1) * part_size_bytes;
      const length = Math.min(part_size_bytes, stat.size - offset);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, offset);

      const { url } = await json(
        await fetch(`${API}/videos/${video.id}/upload/parts/${partNumber}/url`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }),
      );

      const putRes = await fetch(url, { method: 'PUT', body: buffer });
      if (!putRes.ok) {
        throw new Error(`PUT part ${partNumber} failed: ${putRes.status} ${await putRes.text()}`);
      }
      const etag = putRes.headers.get('etag');
      parts.push({ part_number: partNumber, etag });

      log(
        `Part ${partNumber}/${part_count} uploaded (${(length / 1024 / 1024).toFixed(1)} MiB, etag=${etag})`,
      );
    }
  } finally {
    fs.closeSync(fd);
  }

  log('Completing upload...');
  const completed = await json(
    await fetch(`${API}/videos/${video.id}/upload/complete`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ parts }),
    }),
  );
  log(`Upload completed, status=${completed.status}`);

  log('Polling for worker processing to finish...');
  let final = null;
  for (let attempt = 0; attempt < 120; attempt++) {
    const current = await json(await fetch(`${API}/videos/${video.public_id}`));
    if (current.status === 'ready' || current.status === 'failed') {
      final = current;
      break;
    }
    log(`  status=${current.status}, waiting...`);
    await sleep(2000);
  }

  if (!final) {
    throw new Error('Timed out waiting for processing to finish (240s)');
  }

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(final, null, 2));

  if (final.status === 'ready') {
    const playback = await json(await fetch(`${API}/videos/${video.public_id}/playback`));
    const download = await json(await fetch(`${API}/videos/${video.public_id}/download`));
    console.log('\nPlayback URL:', playback.url);
    console.log('Download URL:', download.url);
    log('SUCCESS ✅');
  } else {
    log('Video failed processing ❌ (see error_reason above, if present)');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
