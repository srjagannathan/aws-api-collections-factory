// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface PostmanCollectionGeneratorStackProps extends cdk.StackProps {
  repositoryRoot: string;
  domainName: string;
  hostedZoneId: string;
  hostedZoneName: string;
  certificateArn: string;
}

export class PostmanCollectionGeneratorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PostmanCollectionGeneratorStackProps) {
    super(scope, id, props);

    const applicationName = 'postman-collection-generator';
    const administratorGroup = 'Administrators';
    const applicationUrl = `https://${props.domainName}/`;

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });
    const certificate = certificatemanager.Certificate.fromCertificateArn(
      this,
      'Certificate',
      props.certificateArn,
    );

    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const stateBucket = new s3.Bucket(this, 'StateBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      lifecycleRules: [
        {
          id: 'ExpireJobLogs',
          prefix: 'jobs/',
          expiration: cdk.Duration.days(30),
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
        {
          id: 'ExpireOlderStateVersions',
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const jobsTable = new dynamodb.Table(this, 'JobsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expires_at',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    jobsTable.addGlobalSecondaryIndex({
      indexName: 'build_id-index',
      partitionKey: { name: 'build_id', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${applicationName}-administrators`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      passwordPolicy: {
        minLength: 14,
        requireDigits: true,
        requireLowercase: true,
        requireSymbols: true,
        requireUppercase: true,
        tempPasswordValidity: cdk.Duration.days(7),
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const userPoolClient = userPool.addClient('BrowserClient', {
      userPoolClientName: `${applicationName}-browser`,
      generateSecret: false,
      preventUserExistenceErrors: true,
      authFlows: { userSrp: true },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [applicationUrl],
        logoutUrls: [applicationUrl],
      },
    });
    const domainPrefix = `pcg-${cdk.Aws.ACCOUNT_ID}`;
    const userPoolDomain = userPool.addDomain('HostedUiDomain', {
      cognitoDomain: { domainPrefix },
    });
    new cognito.CfnUserPoolGroup(this, 'AdministratorGroup', {
      userPoolId: userPool.userPoolId,
      groupName: administratorGroup,
      description: 'Administrators authorized to operate collection jobs.',
    });

    const postmanSecret = new secretsmanager.Secret(this, 'PostmanApiKey', {
      description: 'Postman API key used only by managed collection jobs.',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ configured: false }),
        generateStringKey: 'apiKey',
        excludePunctuation: true,
        passwordLength: 40,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const originSecret = new secretsmanager.Secret(this, 'CloudFrontOriginSecret', {
      description: 'CloudFront origin verification value shared with the API Lambda.',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'headerValue',
        excludePunctuation: true,
        passwordLength: 48,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const originHeaderValue = originSecret.secretValueFromJson('headerValue').unsafeUnwrap();

    const pipelineSource = new s3assets.Asset(this, 'PipelineSource', {
      path: props.repositoryRoot,
      ignoreMode: cdk.IgnoreMode.GLOB,
      exclude: [
        '.git',
        '.git/**',
        '.gradle/**',
        '.claude/**',
        '.codex/**',
        '**/.DS_Store',
        '**/node_modules/**',
        '**/dist/**',
        '**/*.tsbuildinfo',
        'build/**',
        'cdk.out/**',
        'deploy/aws/cdk.out/**',
        'output/**',
        '**/state/**',
        'webui/**',
      ],
    });
    const buildLogGroup = new logs.LogGroup(this, 'BuildLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const project = new codebuild.Project(this, 'PipelineProject', {
      projectName: `${applicationName}-jobs`,
      description: 'Runs Git, Smithy, OpenAPI, and Postman collection pipeline jobs.',
      source: codebuild.Source.s3({
        bucket: pipelineSource.bucket,
        path: pipelineSource.s3ObjectKey,
      }),
      buildSpec: codebuild.BuildSpec.fromSourceFilename('deploy/aws/buildspec.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: false,
        environmentVariables: {
          STATE_BUCKET: { value: stateBucket.bucketName },
          APISYNC_MODELS_URL: { value: 'https://github.com/aws/api-models-aws.git' },
          APISYNC_SOURCE_REMOTE: { value: 'origin' },
          APISYNC_SOURCE_BRANCH: { value: 'main' },
          APISYNC_LOCAL_BRANCH: { value: 'main' },
          POSTMAN_API_KEY: {
            value: `${postmanSecret.secretArn}:apiKey`,
            type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
          },
        },
      },
      logging: {
        cloudWatch: { logGroup: buildLogGroup, prefix: 'pipeline' },
      },
      timeout: cdk.Duration.hours(1),
      concurrentBuildLimit: 1,
    });
    pipelineSource.grantRead(project);
    stateBucket.grantReadWrite(project);
    postmanSecret.grantRead(project);

    const commonFunction = {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: true,
        sourceMap: false,
        format: nodejs.OutputFormat.ESM,
        target: 'node24',
      },
      depsLockFilePath: join(props.repositoryRoot, 'backend', 'package-lock.json'),
      projectRoot: join(props.repositoryRoot, 'backend'),
    } satisfies Partial<nodejs.NodejsFunctionProps>;

    const hostedUiDomain = userPoolDomain.baseUrl();
    const apiFunctionLogs = new logs.LogGroup(this, 'ApiFunctionLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const apiFunction = new nodejs.NodejsFunction(this, 'ApiFunction', {
      ...commonFunction,
      entry: join(props.repositoryRoot, 'backend', 'src', 'cloud-api.ts'),
      handler: 'handler',
      logGroup: apiFunctionLogs,
      environment: {
        STATE_BUCKET: stateBucket.bucketName,
        JOBS_TABLE: jobsTable.tableName,
        CODEBUILD_PROJECT: project.projectName,
        ORIGIN_HEADER_VALUE: originHeaderValue,
        ADMINISTRATOR_GROUP: administratorGroup,
        COGNITO_AUTHORITY: userPool.userPoolProviderUrl,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        COGNITO_HOSTED_UI_DOMAIN: hostedUiDomain,
        COGNITO_REDIRECT_URI: applicationUrl,
        COGNITO_LOGOUT_URI: applicationUrl,
      },
    });
    stateBucket.grantReadWrite(apiFunction);
    jobsTable.grantReadWriteData(apiFunction);
    apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['codebuild:StartBuild'],
      resources: [project.projectArn],
    }));

    const buildEventFunctionLogs = new logs.LogGroup(this, 'BuildEventFunctionLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const buildEventFunction = new nodejs.NodejsFunction(this, 'BuildEventFunction', {
      ...commonFunction,
      entry: join(props.repositoryRoot, 'backend', 'src', 'cloud-build-events.ts'),
      handler: 'handler',
      logGroup: buildEventFunctionLogs,
      environment: { JOBS_TABLE: jobsTable.tableName },
    });
    jobsTable.grantReadWriteData(buildEventFunction);
    new events.Rule(this, 'BuildStateRule', {
      eventPattern: {
        source: ['aws.codebuild'],
        detailType: ['CodeBuild Build State Change'],
        detail: {
          'project-name': [project.projectName],
          'build-status': ['SUCCEEDED', 'FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'],
        },
      },
      targets: [new eventTargets.LambdaFunction(buildEventFunction)],
    });

    const httpApi = new apigateway.HttpApi(this, 'HttpApi', {
      apiName: `${applicationName}-api`,
      description: 'Protected browser API for collection generation.',
    });
    const apiIntegration = new integrations.HttpLambdaIntegration('ApiIntegration', apiFunction);
    httpApi.addRoutes({
      path: '/api/config',
      methods: [apigateway.HttpMethod.GET],
      integration: apiIntegration,
    });
    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      userPool.userPoolProviderUrl,
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );
    httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigateway.HttpMethod.ANY],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    });

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `${applicationName}-web-acl`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'PostmanCollectionGeneratorWebAcl',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedCommonRules',
          priority: 10,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedCommonRules',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedKnownBadInputs',
          priority: 20,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedKnownBadInputs',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'PerIpRateLimit',
          priority: 30,
          action: { block: {} },
          statement: {
            rateBasedStatement: { aggregateKeyType: 'IP', limit: 1000 },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'PerIpRateLimit',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    const responseHeaders = new cloudfront.ResponseHeadersPolicy(this, 'ResponseHeaders', {
      responseHeadersPolicyName: `${applicationName}-security-headers`,
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'none'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "font-src 'self' data:",
            `connect-src 'self' ${hostedUiDomain}`,
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "object-src 'none'",
          ].join('; '),
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [{
          header: 'Permissions-Policy',
          value: 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
          override: true,
        }],
      },
    });
    const apiOrigin = new origins.HttpOrigin(
      `${httpApi.apiId}.execute-api.${this.region}.${cdk.Aws.URL_SUFFIX}`,
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        customHeaders: { 'X-PCG-Origin': originHeaderValue },
      },
    );
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Postman Collection Generator',
      defaultRootObject: 'index.html',
      domainNames: [props.domainName],
      certificate,
      webAclId: webAcl.attrArn,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: responseHeaders,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: responseHeaders,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          compress: true,
        },
      },
    });

    new s3deploy.BucketDeployment(this, 'FrontendDeployment', {
      sources: [s3deploy.Source.asset(join(props.repositoryRoot, 'webui', 'static'))],
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true,
      cacheControl: [s3deploy.CacheControl.noCache()],
    });

    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, 'Ipv6AliasRecord', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });

    const outputs: Record<string, string> = {
      ApplicationUrl: applicationUrl,
      StateBucketName: stateBucket.bucketName,
      JobsTableName: jobsTable.tableName,
      UserPoolId: userPool.userPoolId,
      UserPoolClientId: userPoolClient.userPoolClientId,
      AdministratorGroupName: administratorGroup,
      PostmanSecretArn: postmanSecret.secretArn,
      CodeBuildProjectName: project.projectName,
      DistributionId: distribution.distributionId,
    };
    for (const [outputId, value] of Object.entries(outputs)) {
      new cdk.CfnOutput(this, outputId, { value });
    }
  }
}
