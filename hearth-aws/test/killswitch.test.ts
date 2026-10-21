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
const base = loadConfig(projectRoot, 'config/example.json');
let n = 0;
const synth = (over: Partial<HearthConfig> = {}) =>
  Template.fromStack(new HearthStack(new App(), `K${n++}`, { config: { ...base, ...over }, projectRoot, env: { account: '111122223333', region: 'eu-west-1' } }));

describe('kill switch', () => {
  const t = synth();
  const res = t.toJSON().Resources as Record<string, { Type: string; Properties: Record<string, any> }>;
  const idOf = (type: string, pred: (p: Record<string, any>) => boolean = () => true) => Object.entries(res).find(([, r]) => r.Type === type && pred(r.Properties))![0];

  it('a Hearth-only cost budget at killSwitchUsd (default $1)', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: { BudgetName: 'hearth-laptop-killswitch', BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: 1, Unit: 'USD' }, CostFilters: { TagKeyValue: ['user:project$hearth'] } },
    });
  });

  it('acts automatically on ACTUAL spend at 100 %, applying the deny policy to exactly the skill and rule roles', () => {
    const skillRole = res[Object.values(res).find((r) => r.Type === 'AWS::Lambda::Function')!.Properties.Role['Fn::GetAtt'][0]];
    expect(skillRole).toBeDefined();
    const action = Object.values(res).find((r) => r.Type === 'AWS::Budgets::BudgetsAction')!.Properties;
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

  it('every resource is tagged project=hearth (what the cost filter counts)', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { Tags: Match.arrayWith([{ Key: 'project', Value: 'hearth' }]) });
    t.hasResourceProperties('AWS::DynamoDB::Table', { Tags: Match.arrayWith([{ Key: 'project', Value: 'hearth' }]) });
  });
});

describe('configurable amounts', () => {
  it('killSwitchUsd and budgetAlertUsd flow into the budgets', () => {
    const t = synth({ killSwitchUsd: 2.5, budgetAlertUsd: 10 });
    t.hasResourceProperties('AWS::Budgets::Budget', { Budget: Match.objectLike({ BudgetName: 'hearth-laptop-killswitch', BudgetLimit: { Amount: 2.5, Unit: 'USD' } }) });
    t.hasResourceProperties('AWS::Budgets::Budget', { Budget: Match.objectLike({ BudgetName: 'hearth-laptop-monthly', BudgetLimit: { Amount: 10, Unit: 'USD' } }) });
  });

  it('CDK context overrides are validated like the config file', () => {
    expect(applyOverrides(base, { killSwitchUsd: 3 }).killSwitchUsd).toBe(3);
    expect(() => applyOverrides(base, { killSwitchUsd: -1 })).toThrow(/Invalid override/);
    expect(() => applyOverrides(base, { killSwitchUsd: 500 })).toThrow(/Invalid override/);
  });

  it('scripts/kill-switch.sh set updates config/local.json and rejects bad values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hearth-ks-'));
    const cfg = join(dir, 'local.json');
    writeFileSync(cfg, JSON.stringify({ hubId: 'laptop', killSwitchUsd: 1 }));
    const run = (...a: string[]) => spawnSync('bash', [join(projectRoot, 'scripts', 'kill-switch.sh'), ...a], { env: { ...process.env, HEARTH_CONFIG: cfg, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    expect(run('set', '2.5').status).toBe(0);
    expect(JSON.parse(readFileSync(cfg, 'utf8')).killSwitchUsd).toBe(2.5);
    for (const bad of ['0', '-1', 'abc', '1000']) expect(run('set', bad).status, bad).not.toBe(0);
    expect(JSON.parse(readFileSync(cfg, 'utf8')).killSwitchUsd).toBe(2.5);
  });
});
