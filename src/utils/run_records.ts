import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export function safeRunRecordName(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function writeRunRecord(
  runsDir: string,
  runId: string,
  record: Record<string, unknown>,
): string {
  const name = safeRunRecordName(runId) || crypto.randomBytes(8).toString('hex');
  const recordPath = path.join(runsDir, `${name}.json`);
  const payload = {
    ...record,
    run_id: runId,
    updated_at_ms: Date.now(),
  };
  _atomicWrite(recordPath, JSON.stringify(payload, null, 2));
  return recordPath;
}

function _atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmpPath, filePath);
    try {
      const dirFd = fs.openSync(dir, 'r');
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch {
      // best effort
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}
