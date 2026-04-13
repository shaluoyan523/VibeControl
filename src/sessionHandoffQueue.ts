import * as fs from 'fs';
import * as path from 'path';
import { CreateSessionHandoffInput, SessionHandoffService } from './sessionHandoffService';
import { getVibeControlHandoffQueueDir } from './runtimePaths';

const POLL_INTERVAL_MS = 1000;

interface HandoffQueueRequestEnvelope {
  id: string;
  createdAt: string;
  input: CreateSessionHandoffInput;
}

export class SessionHandoffQueueProcessor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly sessionHandoffService: SessionHandoffService,
    private readonly queueDir = getVibeControlHandoffQueueDir(),
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    fs.mkdirSync(this.queueDir, { recursive: true });
    this.timer = setInterval(() => {
      void this.flushOnce();
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
    void this.flushOnce();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async flushOnce(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const entries = fs.existsSync(this.queueDir)
        ? fs.readdirSync(this.queueDir)
            .filter(name => name.endsWith('.request.json'))
            .sort()
        : [];

      for (const entry of entries) {
        const requestPath = path.join(this.queueDir, entry);
        const processingPath = requestPath.replace(/\.request\.json$/, '.processing.json');

        try {
          fs.renameSync(requestPath, processingPath);
        } catch {
          continue;
        }

        await this.processRequest(processingPath);
      }
    } finally {
      this.running = false;
    }
  }

  private async processRequest(processingPath: string): Promise<void> {
    let requestId = path.basename(processingPath).replace(/\.processing\.json$/, '');

    try {
      const parsed = JSON.parse(fs.readFileSync(processingPath, 'utf-8')) as HandoffQueueRequestEnvelope;
      if (typeof parsed?.id === 'string' && parsed.id.trim().length > 0) {
        requestId = parsed.id.trim();
      }

      const result = await this.sessionHandoffService.createHandoff(parsed.input);
      fs.writeFileSync(
        this.resolveResultPath(requestId),
        JSON.stringify(result, null, 2),
        'utf-8',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fs.writeFileSync(this.resolveErrorPath(requestId), message, 'utf-8');
    } finally {
      try {
        fs.unlinkSync(processingPath);
      } catch {
        // ignore
      }
    }
  }

  private resolveResultPath(requestId: string): string {
    return path.join(this.queueDir, `${requestId}.result.json`);
  }

  private resolveErrorPath(requestId: string): string {
    return path.join(this.queueDir, `${requestId}.error.txt`);
  }
}
