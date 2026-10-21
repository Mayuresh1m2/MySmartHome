import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig, type HearthConfig } from '../lib/config.js';
import { HearthStack } from '../lib/hearth-stack.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = loadConfig(projectRoot, { envFile: 'test/fixtures/test.env', env: {} });
let n = 0;
const synth = (over: Partial<HearthConfig> = {}) =>
  Template.fromStack(new HearthStack(new App(), `T${n++}`, { config: { ...base, ...over }, projectRoot, env: { account: '111122223333', region: 'ap-southeast-2' } }));

describe('M4 hardening', () => {
  const t = synth();

  it('a $5 monthly cost budget emails budgetEmail when actual spend exceeds it', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: { BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: 5, Unit: 'USD' } },
      NotificationsWithSubscribers: [
        {
          Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 100, ThresholdType: 'PERCENTAGE' },
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'you@example.com' }],
        },
      ],
    });
  });

  it('Lambda errors alarm into an SNS topic with an email subscription', () => {
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'you@example.com' });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: [Match.objectLike({ Ref: Match.stringLikeRegexp('Alerts') })],
    });
  });

  it('dashboard shows outcomes and latency from the EMF namespace', () => {
    const dash = Object.values(t.findResources('AWS::CloudWatch::Dashboard'))[0]!;
    const body = JSON.stringify(dash.Properties.DashboardBody);
    expect(body).toContain('Hearth');
    expect(body).toContain('ReplyLatency');
    expect(body).toContain('timeout');
  });

  it('DEBUG_UTTERANCES follows config and is off by default', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ DEBUG_UTTERANCES: 'false' }) } });
    synth({ debugUtterances: true }).hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ DEBUG_UTTERANCES: 'true' }) },
    });
  });
});

describe('certificate rotation', () => {
  const csr = base.csrPem;

  it('adding a certificate keeps the existing one untouched (same logical id, same CSR)', () => {
    const before = synth().toJSON().Resources;
    const after = synth({ hubCertificates: [{ name: 'primary', csrPem: csr, active: true }, { name: 'next', csrPem: csr, active: true }] }).toJSON().Resources;
    expect(after.HubCertificate).toEqual(before.HubCertificate);
    expect(after.HubPolicyAttachment).toBeDefined();
    expect(after.HubCertificatenext.Properties.Status).toBe('ACTIVE');
    expect(after.HubPolicyAttachmentnext).toBeDefined();
    expect(after.HubThingAttachmentnext).toBeDefined();
  });

  it('deactivating the old certificate is a status change, not a replacement', () => {
    const t = synth({ hubCertificates: [{ name: 'primary', csrPem: csr, active: false }, { name: 'next', csrPem: csr, active: true }] });
    expect(t.toJSON().Resources.HubCertificate.Properties.Status).toBe('INACTIVE');
    t.resourceCountIs('AWS::IoT::Certificate', 2);
    t.resourceCountIs('AWS::IoT::Policy', 1); // still exactly one policy with the four statements
  });
});
