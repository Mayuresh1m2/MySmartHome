import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../lib/config.js';
import { HearthStack } from '../lib/hearth-stack.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = '111122223333';
const arn = (r: string) => `arn:aws:iot:eu-west-1:${ACCOUNT}:${r}`;
let t: Template;

type Statement = { Effect: string; Action: string | string[]; Resource: unknown };
const actionsOf = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

beforeAll(() => {
  const config = loadConfig(projectRoot, 'config/example.json');
  const app = new App();
  const stack = new HearthStack(app, 'Test', { config, projectRoot, env: { account: ACCOUNT, region: 'eu-west-1' } });
  t = Template.fromStack(stack);
});

describe('hub identity', () => {
  it('creates the certificate from the CSR, active, and never creates keys', () => {
    const certs = t.findResources('AWS::IoT::Certificate');
    expect(Object.keys(certs)).toHaveLength(1);
    const props = Object.values(certs)[0]!.Properties;
    expect(props.Status).toBe('ACTIVE');
    expect(props.CertificateSigningRequest).toContain('BEGIN CERTIFICATE REQUEST');
    expect(JSON.stringify(t.toJSON())).not.toMatch(/PRIVATE KEY/);
  });

  it('thing is hearth-<hubId> and the cert is attached to thing and policy', () => {
    t.hasResourceProperties('AWS::IoT::Thing', { ThingName: 'hearth-laptop' });
    t.resourceCountIs('AWS::IoT::ThingPrincipalAttachment', 1);
    t.resourceCountIs('AWS::IoT::PolicyPrincipalAttachment', 1);
  });

  it('hub policy allows exactly the four contract permissions and nothing else', () => {
    const policies = Object.values(t.findResources('AWS::IoT::Policy'));
    expect(policies).toHaveLength(1);
    const statements = policies[0]!.Properties.PolicyDocument.Statement as Statement[];
    expect(statements).toEqual([
      { Effect: 'Allow', Action: 'iot:Connect', Resource: arn('client/hearth-laptop') },
      { Effect: 'Allow', Action: 'iot:Subscribe', Resource: arn('topicfilter/hearth/laptop/commands') },
      { Effect: 'Allow', Action: 'iot:Receive', Resource: arn('topic/hearth/laptop/commands') },
      { Effect: 'Allow', Action: 'iot:Publish', Resource: arn('topic/hearth/laptop/replies') },
    ]);
  });
});

describe('replies path', () => {
  it('table is on-demand, keyed by requestId, with TTL on expiresAt, and retained', () => {
    t.hasResource('AWS::DynamoDB::Table', {
      Properties: {
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'requestId', KeyType: 'HASH' }],
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      },
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  it('rule SQL matches the spec exactly and writes with DynamoDBv2', () => {
    t.hasResourceProperties('AWS::IoT::TopicRule', {
      TopicRulePayload: Match.objectLike({
        Sql: "SELECT *, floor(timestamp() / 1000) + 300 AS expiresAt FROM 'hearth/laptop/replies'",
        AwsIotSqlVersion: '2016-03-23',
        Actions: [Match.objectLike({ DynamoDBv2: Match.anyValue() })],
        ErrorAction: Match.objectLike({ CloudwatchLogs: Match.anyValue() }),
      }),
    });
  });
});

describe('skill lambda', () => {
  it('Node.js 22, 7 s timeout, 256 MB, with the expected environment', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Timeout: 7,
      MemorySize: 256,
      Environment: {
        Variables: Match.objectLike({ HUB_ID: 'laptop', REPLY_TIMEOUT_MS: '5000', DEBUG_UTTERANCES: 'false', SKILL_ID: Match.stringLikeRegexp('^amzn1\\.ask\\.skill\\.') }),
      },
    });
  });

  it('only Alexa with this skill ID may invoke it', () => {
    const perms = Object.values(t.findResources('AWS::Lambda::Permission'));
    expect(perms).toHaveLength(1);
    expect(perms[0]!.Properties).toMatchObject({
      Action: 'lambda:InvokeFunction',
      Principal: 'alexa-appkit.amazon.com',
      EventSourceToken: 'amzn1.ask.skill.00000000-0000-0000-0000-000000000000',
    });
  });

  it('role may only publish to the commands topic, read a reply and write its own logs', () => {
    const fn = Object.values(t.findResources('AWS::Lambda::Function'))[0]!;
    const roleId = fn.Properties.Role['Fn::GetAtt'][0];
    const role = t.toJSON().Resources[roleId];
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    const statements = role.Properties.Policies.flatMap((p: { PolicyDocument: { Statement: Statement[] } }) => p.PolicyDocument.Statement) as Statement[];
    const actions = statements.flatMap(actionsOf).sort();
    expect(actions).toEqual(['dynamodb:GetItem', 'iot:Publish', 'logs:CreateLogStream', 'logs:PutLogEvents']);
    const publish = statements.find((s) => actionsOf(s).includes('iot:Publish'))!;
    expect(publish.Resource).toBe(arn('topic/hearth/laptop/commands'));
    for (const s of statements) {
      expect(s.Effect).toBe('Allow');
      expect(JSON.stringify(s.Resource)).not.toBe('"*"');
    }
    // No other IAM policies attached to the role from outside.
    const extra = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify(p.Properties.Roles).includes(roleId),
    );
    expect(extra).toHaveLength(0);
  });

  it('logs are kept 14 days', () => {
    const groups = Object.values(t.findResources('AWS::Logs::LogGroup'));
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const g of groups) expect(g.Properties.RetentionInDays).toBe(14);
  });
});

describe('no public endpoints', () => {
  it('has no function URL, API Gateway or load balancer', () => {
    const types = new Set(Object.values(t.toJSON().Resources as Record<string, { Type: string }>).map((r) => r.Type));
    for (const banned of ['AWS::Lambda::Url', 'AWS::ApiGateway::RestApi', 'AWS::ApiGatewayV2::Api', 'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::CloudFront::Distribution']) {
      expect(types.has(banned), banned).toBe(false);
    }
  });
});
