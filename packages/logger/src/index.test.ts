import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './index.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('writes JSON with service name and string level', () => {
    const { lines, stream } = capture();
    createLogger({ service: 'subgraph-flights', destination: stream }).info('hello');
    expect(lines[0]).toMatchObject({ service: 'subgraph-flights', level: 'info', msg: 'hello' });
    expect(typeof lines[0]?.time).toBe('string');
  });

  it('redacts secrets', () => {
    const { lines, stream } = capture();
    createLogger({ service: 'gateway', destination: stream }).info(
      {
        req: { headers: { authorization: 'Bearer abc' } },
        passenger: { passportNumber: 'A1234567' },
      },
      'request',
    );
    const output = JSON.stringify(lines[0]);
    expect(output).not.toContain('Bearer abc');
    expect(output).not.toContain('A1234567');
  });

  it('respects the configured level', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: 'x', level: 'warn', destination: stream });
    logger.info('dropped');
    logger.warn('kept');
    expect(lines.map((line) => line.msg)).toEqual(['kept']);
  });
});
