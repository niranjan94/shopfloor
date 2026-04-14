import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPrompt } from '../../src/prompt-render';

describe('renderPrompt', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shopfloor-render-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('substitutes known keys', () => {
    const path = join(tmpDir, 'p.md');
    writeFileSync(path, 'Hello {{name}} from {{place}}.');
    const result = renderPrompt(path, { name: 'Marvin', place: 'Sirius Cybernetics' });
    expect(result).toBe('Hello Marvin from Sirius Cybernetics.');
  });

  test('marks missing keys', () => {
    const path = join(tmpDir, 'p.md');
    writeFileSync(path, 'Hello {{name}} from {{missing_key}}.');
    const result = renderPrompt(path, { name: 'Marvin' });
    expect(result).toContain('{{MISSING:missing_key}}');
  });

  test('allows whitespace in placeholder', () => {
    const path = join(tmpDir, 'p.md');
    writeFileSync(path, 'Value: {{  spaced_key  }}');
    const result = renderPrompt(path, { spaced_key: 'ok' });
    expect(result).toBe('Value: ok');
  });
});
