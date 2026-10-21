import { App } from 'aws-cdk-lib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOverrides, loadConfig } from '../lib/config.js';
import { HearthStack } from '../lib/hearth-stack.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = new App();
// One-off overrides without editing config: pnpm cdk deploy -c hearthKillSwitchUsd=2 -c accountKillSwitchUsd=10
const fromContext = (key: 'hearthKillSwitchUsd' | 'accountKillSwitchUsd') => {
  const v = app.node.tryGetContext(key);
  return v === undefined ? {} : { [key]: Number(v) };
};
const config = applyOverrides(loadConfig(projectRoot), { ...fromContext('hearthKillSwitchUsd'), ...fromContext('accountKillSwitchUsd') });
new HearthStack(app, `Hearth-${config.hubId}`, {
  config,
  projectRoot,
  // Region is fixed by the contract; the account comes from the CLI profile.
  env: { region: 'ap-southeast-2', account: process.env.CDK_DEFAULT_ACCOUNT },
  description: `Hearth: Alexa skill relay to home hub ${config.hubId}`,
  tags: { project: 'hearth', hubId: config.hubId },
});
