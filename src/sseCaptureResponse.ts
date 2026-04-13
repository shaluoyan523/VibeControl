import { EventEmitter } from 'events';
import * as http from 'http';

export class SseCaptureResponse extends EventEmitter {
  private buffer = '';
  private currentEvent = '';
  private finished = false;
  private doneData: { code?: number; error?: string } = {};

  writeHead(_statusCode: number, _headers?: http.OutgoingHttpHeaders): this {
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        this.currentEvent = line.slice(7).trim();
        continue;
      }

      if (line.startsWith('data: ')) {
        const raw = line.slice(6);
        let parsed: any = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Keep raw string if payload is not JSON.
        }

        if (this.currentEvent === 'error') {
          this.doneData.error = typeof parsed?.error === 'string' ? parsed.error : String(parsed);
        } else if (this.currentEvent === 'done') {
          if (typeof parsed?.code === 'number') {
            this.doneData.code = parsed.code;
          }
          if (typeof parsed?.error === 'string' && parsed.error) {
            this.doneData.error = parsed.error;
          }
          this.finished = true;
          this.emit('done', this.doneData);
        }

        this.currentEvent = '';
        continue;
      }

      if (!line.trim()) {
        this.currentEvent = '';
      }
    }

    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk) {
      this.write(chunk);
    }
    if (!this.finished) {
      this.finished = true;
      this.emit('done', this.doneData);
    }
    this.emit('close');
    return this;
  }

  asServerResponse(): http.ServerResponse {
    return this as unknown as http.ServerResponse;
  }

  waitForDone(timeoutMs: number): Promise<{ code?: number; error?: string }> {
    if (this.finished) {
      return Promise.resolve(this.doneData);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve({
          ...this.doneData,
          error: this.doneData.error || `Timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        this.removeListener('done', onDone);
      };

      const onDone = (data: { code?: number; error?: string }) => {
        cleanup();
        resolve(data);
      };

      this.on('done', onDone);
    });
  }

  isDone(): boolean {
    return this.finished;
  }

  getError(): string | undefined {
    return this.doneData.error;
  }
}
