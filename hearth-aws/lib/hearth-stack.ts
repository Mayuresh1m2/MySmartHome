import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnCertificate, CfnPolicy, CfnPolicyPrincipalAttachment, CfnThing, CfnThingPrincipalAttachment, CfnTopicRule } from 'aws-cdk-lib/aws-iot';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { Alarm, AlarmStatusWidget, ComparisonOperator, Dashboard, GraphWidget, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { join } from 'node:path';
import type { HearthConfig } from './config.js';

export interface HearthStackProps extends StackProps {
  config: HearthConfig;
  /** Absolute path of the hearth-aws project (for the Lambda entry). */
  projectRoot: string;
}

export class HearthStack extends Stack {
  constructor(scope: Construct, id: string, props: HearthStackProps) {
    super(scope, id, props);
    const { config } = props;
    const name = `hearth-${config.hubId}`;
    const commandsTopic = `hearth/${config.hubId}/commands`;
    const repliesTopic = `hearth/${config.hubId}/replies`;
    // The contract pins eu-west-1, which is always in the "aws" partition; a literal keeps ARNs exact and reviewable.
    const iotArn = (resource: string) => `arn:aws:iot:${this.region}:${this.account}:${resource}`;

    // ---- Hub identity: certificates from the hub's CSRs. AWS never creates or sees the private key.
    // Each certificate has a stable logical id from its config name, so rotation adds one rather than replacing.
    const thing = new CfnThing(this, 'HubThing', { thingName: name });
    const hubPolicy = new CfnPolicy(this, 'HubPolicy', {
      policyName: `${name}-policy`,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: 'iot:Connect', Resource: iotArn(`client/${name}`) },
          { Effect: 'Allow', Action: 'iot:Subscribe', Resource: iotArn(`topicfilter/${commandsTopic}`) },
          { Effect: 'Allow', Action: 'iot:Receive', Resource: iotArn(`topic/${commandsTopic}`) },
          { Effect: 'Allow', Action: 'iot:Publish', Resource: iotArn(`topic/${repliesTopic}`) },
        ],
      },
    });
    for (const c of config.hubCertificates) {
      // The first certificate keeps the original logical ids so existing stacks are not replaced.
      const suffix = c.name === 'primary' ? '' : c.name;
      const cert = new CfnCertificate(this, `HubCertificate${suffix}`, {
        certificateSigningRequest: c.csrPem,
        status: c.active ? 'ACTIVE' : 'INACTIVE',
      });
      const policyAttach = new CfnPolicyPrincipalAttachment(this, `HubPolicyAttachment${suffix}`, {
        policyName: hubPolicy.policyName!,
        principal: cert.attrArn,
      });
      policyAttach.addResourceDependency(hubPolicy);
      const thingAttach = new CfnThingPrincipalAttachment(this, `HubThingAttachment${suffix}`, {
        thingName: thing.thingName!,
        principal: cert.attrArn,
      });
      thingAttach.addResourceDependency(thing);
      new CfnOutput(this, `HubCertificateId${suffix}`, {
        value: cert.ref,
        description: `Certificate "${c.name}" (${c.active ? 'ACTIVE' : 'INACTIVE'}); scripts/handoff.sh fetches its PEM`,
      });
    }

    // ---- Replies path: hub publishes → IoT rule → DynamoDB item with a 5-minute TTL.
    const replies = new Table(this, 'Replies', {
      partitionKey: { name: 'requestId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      // Replacing or deleting the table needs an explicit decision (hearth-aws working rules).
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const ruleErrors = new LogGroup(this, 'RuleErrors', { retention: RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
    const ruleRole = new Role(this, 'RepliesRuleRole', {
      assumedBy: new ServicePrincipal('iot.amazonaws.com'),
      inlinePolicies: {
        write: new PolicyDocument({
          statements: [
            new PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [replies.tableArn] }),
            new PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'], resources: [ruleErrors.logGroupArn] }),
          ],
        }),
      },
    });
    const rule = new CfnTopicRule(this, 'RepliesRule', {
      topicRulePayload: {
        description: `Write ${repliesTopic} into the replies table with a 5 minute TTL`,
        awsIotSqlVersion: '2016-03-23',
        sql: `SELECT *, floor(timestamp() / 1000) + 300 AS expiresAt FROM '${repliesTopic}'`,
        ruleDisabled: false,
        actions: [{ dynamoDBv2: { putItem: { tableName: replies.tableName }, roleArn: ruleRole.roleArn } }],
        // Observability: failed writes land in a log group instead of vanishing.
        errorAction: { cloudwatchLogs: { logGroupName: ruleErrors.logGroupName, roleArn: ruleRole.roleArn } },
      },
    });

    // ---- Skill Lambda. Its role can publish to the commands topic, read a reply, and write its own logs. Nothing else.
    const logGroup = new LogGroup(this, 'SkillLogs', { retention: RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
    const role = new Role(this, 'SkillRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        skill: new PolicyDocument({
          statements: [
            new PolicyStatement({ actions: ['iot:Publish'], resources: [iotArn(`topic/${commandsTopic}`)] }),
            new PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [replies.tableArn] }),
            new PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [logGroup.logGroupArn] }),
          ],
        }),
      },
    });
    const fn = new NodejsFunction(this, 'SkillFunction', {
      entry: join(props.projectRoot, 'lambda', 'skill', 'src', 'index.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(7),
      role,
      logGroup,
      environment: {
        HUB_ID: config.hubId,
        SKILL_ID: config.skillId,
        IOT_ENDPOINT: config.iotEndpoint,
        REPLIES_TABLE: replies.tableName,
        REPLY_TIMEOUT_MS: String(config.replyTimeoutMs),
        DEBUG_UTTERANCES: String(config.debugUtterances),
      },
      bundling: {
        format: OutputFormat.CJS,
        target: 'node22',
        minify: true,
        sourceMap: true,
        // The Node 22 runtime ships AWS SDK v3.
        externalModules: ['@aws-sdk/*'],
      },
    });
    fn.addPermission('AlexaSkillInvoke', {
      principal: new ServicePrincipal('alexa-appkit.amazon.com'),
      action: 'lambda:InvokeFunction',
      eventSourceToken: config.skillId,
    });

    // ---- Hardening (M4): Lambda error alarm by email, a $5/month budget, and a dashboard over the EMF metrics.
    const alerts = new Topic(this, 'Alerts', { displayName: 'Hearth alerts' });
    alerts.addSubscription(new EmailSubscription(config.budgetEmail));
    const errors = new Alarm(this, 'SkillErrors', {
      alarmDescription: 'The Hearth skill Lambda threw errors (not hub timeouts; those are handled replies).',
      metric: fn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    errors.addAlarmAction(new SnsAction(alerts));

    new CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `hearth-${config.hubId}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 5, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: config.budgetEmail }],
        },
      ],
    });

    const emf = (metricName: string, outcome: string | undefined, statistic: string, label: string) =>
      new Metric({
        namespace: 'Hearth',
        metricName,
        dimensionsMap: outcome ? { HubId: config.hubId, Outcome: outcome } : { HubId: config.hubId },
        statistic,
        period: Duration.minutes(5),
        label,
      });
    new Dashboard(this, 'Dashboard', {
      dashboardName: `hearth-${config.hubId}`,
      widgets: [
        [
          new GraphWidget({
            title: 'Commands by outcome',
            left: ['ok', 'refused', 'error', 'timeout', 'publish_failed', 'bad_reply'].map((o) => emf('Requests', o, 'Sum', o)),
            width: 12,
          }),
          new GraphWidget({
            title: 'Reply latency (ms)',
            left: [emf('ReplyLatency', undefined, 'p50', 'p50'), emf('ReplyLatency', undefined, 'p95', 'p95')],
            leftAnnotations: [{ value: config.replyTimeoutMs, label: 'reply timeout' }],
            width: 12,
          }),
        ],
        [
          new GraphWidget({ title: 'Lambda errors / invocations', left: [fn.metricErrors(), fn.metricInvocations()], width: 12 }),
          new AlarmStatusWidget({ title: 'Alarms', alarms: [errors], width: 12 }),
        ],
      ],
    });

    new CfnOutput(this, 'SkillFunctionArn', { value: fn.functionArn, description: 'Set as the skill endpoint (ASK CLI)' });
    new CfnOutput(this, 'RepliesTableName', { value: replies.tableName });
    new CfnOutput(this, 'HubThingName', { value: name });
    new CfnOutput(this, 'RepliesRuleName', { value: rule.ref });
    new CfnOutput(this, 'IotEndpoint', { value: config.iotEndpoint });
  }
}
