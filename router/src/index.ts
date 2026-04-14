import * as core from '@actions/core';

async function main(): Promise<void> {
  core.info('Shopfloor router: not yet implemented');
  core.setOutput('stage', 'none');
  core.setOutput('reason', 'router stub');
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
