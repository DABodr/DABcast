import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './fsutil.js';

export class FileLogger {
  constructor(logFilePath) {
    this.logFilePath = logFilePath;
    ensureDir(path.dirname(logFilePath));
  }

  line(scope, msg) {
    const ts = new Date().toISOString();
    fs.appendFileSync(this.logFilePath, `[${ts}] [${scope}] ${msg}\n`, 'utf8');
  }
}
