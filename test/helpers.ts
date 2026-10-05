import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InviteService } from '../src/index.ts';
import type { StaticData } from '../src/index.ts';

export const WEEK = 7 * 24 * 60;

export function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'invites-'));
  return { dir, dbPath: join(dir, 'test.db') };
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function makeService(
  data: StaticData,
): { service: InviteService; dir: string; dbPath: string } {
  const { dir, dbPath } = tempDbPath();
  const service = new InviteService(dbPath);
  service.configure(data);
  return { service, dir, dbPath };
}

export const baseData: StaticData = {
  employees: [
    { id: 'e1', qualifications: ['a', 'b'] },
    { id: 'e2', qualifications: ['a'] },
    { id: 'e3', qualifications: ['b'] },
  ],
  shifts: [{ id: 's1', employeeId: 'e1', startMin: 0, endMin: 60 }],
  gaps: [
    { id: 'g1', startMin: 120, endMin: 180, requiredQualifications: ['a'] },
    { id: 'g2', startMin: 240, endMin: 300, requiredQualifications: ['b'] },
  ],
};
