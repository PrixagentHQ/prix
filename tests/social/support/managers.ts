import type { ManagerPolicy, ManagerRecord, ManagerSchedule } from '@prix/contracts';
import { agentNameKey } from '@prix/contracts';
import { testAddress, testId } from '../../support/fixtures.ts';
import type { Stores } from './d1.ts';

/** Words for manager names that no rule blocks. */
const WORDS = ['Amber', 'Birch', 'Cedar', 'Dune', 'Ember', 'Fjord', 'Glade', 'Harbor', 'Iris', 'Juniper'];

export function managerName(n: number): string {
  return `${WORDS[n % 10]} ${WORDS[Math.floor(n / 10) % 10]} ${WORDS[Math.floor(n / 100) % 10]} mix`;
}

export function managerOf(n: number, over: Partial<ManagerRecord> = {}): ManagerRecord {
  const name = managerName(n);
  return {
    id: testId('manager', n),
    owner: testAddress(7000 + n),
    name,
    nameKey: agentNameKey(name),
    status: 'active',
    hidden: false,
    policyVersion: 1,
    createdAt: '2026-10-05T10:00:00.000Z',
    createdDay: '2026-10-05',
    updatedAt: '2026-10-05T10:00:00.000Z',
    ...over,
  };
}

export function policyOf(
  managerId: string,
  version: number,
  targetsBps: Record<string, number>,
  schedule: ManagerSchedule = 'weekly',
  setDay = '2026-10-05',
): ManagerPolicy {
  return { managerId, version, targetsBps, schedule, setAt: `${setDay}T10:00:00.000Z`, setDay };
}

export async function addManager(
  stores: Stores,
  n: number,
  targetsBps: Record<string, number>,
  schedule: ManagerSchedule = 'weekly',
  over: Partial<ManagerRecord> = {},
): Promise<ManagerRecord> {
  const manager = managerOf(n, over);
  const result = await stores.social.createManager(manager, policyOf(manager.id, 1, targetsBps, schedule), {
    maxForOwner: 5,
    maxTotal: 250,
  });
  if (result !== 'created') throw new Error(`addManager ${n}: ${result}`);
  return manager;
}
