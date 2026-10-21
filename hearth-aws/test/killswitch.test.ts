import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyOverrides, loadConfig, type HearthConfig } from '../lib/config.js';
import { HearthStack } from '../lib/hearth-stack.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = loadConfig(projectRoot, { envFile: 'test/fixtures/test.env', env: {} });
let n = 0;
const synth = (over: Partial<HearthConfig> = {}) =>
  Template.fromStack(new HearthStack(new App(), `K${n++}`, { config: { ...base, ...over }, projectRoot, env: { account: '111122223333', region: 'ap-southeast-2' } }));

describe('kill switch', () => {
  const t = synth();
  const res = t.toJSON().Resources as Record<string, { Type: string; Properties: Record<string, any> }>;
  const idOf = (type: string, pred: (p: Record<string, any>) => boolean = () => true) => Object.entries(res).find(([, r]) => r.Type === type && pred(r.Properties))![0];

  it('an unfiltered (whole account) cost budget at hearthKillSwitchUsd (default $1)', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: { BudgetName: 'hearth-laptop-killswitch', BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: 1, Unit: 'USD' }, CostFilters: Match.absent() },
    });
  });

  it('two automatic switches ($1 and $5), both on the same deny policy and roles', () => {
    const actions = Object.values(res).filter((r) => r.Type === 'AWS::Budgets::BudgetsAction').map((r) => r.Properties);
    expect(actions.map((a) => a.BudgetName).sort()).toEqual(['hearth-laptop-killswitch', 'hearth-laptop-monthly']);
    for (const a of actions) {
      expect(a).toMatchObject({ ActionType: 'APPLY_IAM_POLICY', ApprovalModel: 'AUTOMATIC', NotificationType: 'ACTUAL', ActionThreshold: { Type: 'PERCENTAGE', Value: 100 } });
    }
    expect(actions[0]!.Definition).toEqual(actions[1]!.Definition);
    // the account budget counts everything (no tag filter)
    t.hasResourceProperties('AWS::Budgets::Budget', { Budget: Match.objectLike({ BudgetName: 'hearth-laptop-monthly', CostFilters: Match.absent() }) });
  });

  it('acts automatically on ACTUAL spend at 100 %, applying the deny policy to exactly the skill and rule roles', () => {
    const skillRole = res[Object.values(res).find((r) => r.Type === 'AWS::Lambda::Function')!.Properties.Role['Fn::GetAtt'][0]];
    expect(skillRole).toBeDefined();
    const action = Object.values(res).find((r) => r.Type === 'AWS::Budgets::BudgetsAction' && r.Properties.BudgetName === 'hearth-laptop-killswitch')!.Properties;
    expect(action).toMatchObject({
      BudgetName: 'hearth-laptop-killswitch',
      ActionType: 'APPLY_IAM_POLICY',
      ApprovalModel: 'AUTOMATIC',
      NotificationType: 'ACTUAL',
      ActionThreshold: { Type: 'PERCENTAGE', Value: 100 },
      Subscribers: [{ Type: 'EMAIL', Address: 'you@example.com' }],
    });
    const roles = action.Definition.IamActionDefinition.Roles.map((r: { Ref: string }) => r.Ref).sort();
    expect(roles).toEqual([idOf('AWS::IAM::Role', (p) => p.AssumeRolePolicyDocument.Statement[0].Principal.Service === 'iot.amazonaws.com'), idOf('AWS::IAM::Role', (p) => p.AssumeRolePolicyDocument.Statement[0].Principal.Service === 'lambda.amazonaws.com')].sort());
  });

  it('the deny policy denies everything and is NOT attached at deploy time (only Budgets attaches it)', () => {
    const policyId = idOf('AWS::IAM::ManagedPolicy');
    expect(res[policyId]!.Properties.PolicyDocument.Statement).toEqual([{ Effect: 'Deny', Action: '*', Resource: '*' }]);
    for (const r of Object.values(res)) if (r.Type === 'AWS::IAM::Role') expect(JSON.stringify(r.Properties.ManagedPolicyArns ?? [])).not.toContain(policyId);
  });

  it("the Budgets execution role can only attach/detach that one policy on those two roles", () => {
    const role = Object.values(res).find((r) => r.Type === 'AWS::IAM::Role' && r.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service === 'budgets.amazonaws.com')!;
    const [statement, ...rest] = role.Properties.Policies.flatMap((p: { PolicyDocument: { Statement: unknown[] } }) => p.PolicyDocument.Statement);
    expect(rest).toEqual([]);
    expect(statement).toMatchObject({ Effect: 'Allow', Action: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'], Condition: { ArnEquals: { 'iam:PolicyARN': { Ref: idOf('AWS::IAM::ManagedPolicy') } } } });
    expect(statement.Resource).toHaveLength(2);
  });

  it('every resource is tagged project=hearth (Tag Editor, Cost Explorer)', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { Tags: Match.arrayWith([{ Key: 'project', Value: 'hearth' }]) });
    t.hasResourceProperties('AWS::DynamoDB::Table', { Tags: Match.arrayWith([{ Key: 'project', Value: 'hearth' }]) });
  });
});

describe('configurable amounts', () => {
  it('hearthKillSwitchUsd and accountKillSwitchUsd flow into the budgets', () => {
    const t = synth({ hearthKillSwitchUsd: 2.5, accountKillSwitchUsd: 10 });
    t.hasResourceProperties('AWS::Budgets::Budget', { Budget: Match.objectLike({ BudgetName: 'hearth-laptop-killswitch', BudgetLimit: { Amount: 2.5, Unit: 'USD' } }) });
    t.hasResourceProperties('AWS::Budgets::Budget', { Budget: Match.objectLike({ BudgetName: 'hearth-laptop-monthly', BudgetLimit: { Amount: 10, Unit: 'USD' } }) });
  });

  it('CDK context overrides are validated like the config file', () => {
    expect(applyOverrides(base, { hearthKillSwitchUsd: 3 }).hearthKillSwitchUsd).toBe(3);
    expect(() => applyOverrides(base, { hearthKillSwitchUsd: -1 })).toThrow(/Invalid override/);
    expect(() => applyOverrides(base, { hearthKillSwitchUsd: 500 })).toThrow(/Invalid override/);
  });

  it('scripts/kill-switch.sh set hearth|account updates the .env and rejects bad values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hearth-ks-'));
    const env = join(dir, '.env');
    writeFileSync(env, '# my settings\nHEARTH_AWS_REGION=ap-southeast-2\nHEARTH_KILL_SWITCH_USD=1\n');
    const run = (...a: string[]) => spawnSync('bash', [join(projectRoot, 'scripts', 'kill-switch.sh'), ...a], { env: { HEARTH_ENV_FILE: env, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    const read = () => readFileSync(env, 'utf8');
    expect(run('set', 'hearth', '2.5').status).toBe(0);
    expect(run('set', 'account', '20').status).toBe(0); // not in the file yet: appended
    expect(read()).toBe('# my settings\nHEARTH_AWS_REGION=ap-southeast-2\nHEARTH_KILL_SWITCH_USD=2.5\nHEARTH_ACCOUNT_KILL_SWITCH_USD=20\n');
    for (const bad of ['0', '-1', 'abc', '1000']) expect(run('set', 'hearth', bad).status, bad).not.toBe(0);
    expect(run('set', 'account', '5000').status).not.toBe(0);
    expect(run('set', 'everything', '1').status).not.toBe(0);
    expect(read()).toContain('HEARTH_KILL_SWITCH_USD=2.5');
  });
});
