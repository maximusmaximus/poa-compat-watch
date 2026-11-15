import baseline from '../baseline.json' with { type: 'json' };
import poaDomains from '../apps/poa-domains.json' with { type: 'json' };
import poaDice from '../apps/poa-dice.json' with { type: 'json' };
import proofFloor from '../apps/proof-floor.json' with { type: 'json' };
import poaAgentKit from '../apps/poa-agent-kit.json' with { type: 'json' };
import poaKeygen from '../apps/poa-keygen.json' with { type: 'json' };

export const bundledBaseline = baseline;

export const bundledApps = [poaDomains, poaDice, proofFloor, poaAgentKit, poaKeygen];

export function bundledCatalog() {
  return { baseline: bundledBaseline, apps: bundledApps };
}
