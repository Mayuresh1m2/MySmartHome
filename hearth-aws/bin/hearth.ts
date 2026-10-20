import { App } from 'aws-cdk-lib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.js';
import { HearthStack } from '../lib/hearth-stack.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(projectRoot);
const app = new App();
new HearthStack(app, `Hearth-${config.hubId}`, {
  config,
  projectRoot,
  // Region is fixed by the contract; the account comes from the CLI profile.
  env: { region: 'eu-west-1', account: process.env.CDK_DEFAULT_ACCOUNT },
  description: `Hearth: Alexa skill relay to home hub ${config.hubId}`,
  tags: { project: 'hearth', hubId: config.hubId },
});
