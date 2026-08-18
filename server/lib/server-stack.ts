import * as path from 'node:path';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cdk from 'aws-cdk-lib/core';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

const SITE_DOMAIN = 'safebadge.ori.mx';
const HOSTED_ZONE_NAME = 'ori.mx';
const HOSTED_ZONE_ID = 'Z08759423MBZ45TTPSACA';
const TWITCH_CLIENT_ID_PARAMETER = '/safetwitch/prod/twitch-client-id';
const TWITCH_CLIENT_SECRET_PARAMETER = '/safetwitch/prod/twitch-client-secret';

export class ServerStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		const table = new dynamodb.Table(this, 'SafetyTable', {
			partitionKey: {
				name: 'pk',
				type: dynamodb.AttributeType.STRING
			},
			billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
			encryption: dynamodb.TableEncryption.AWS_MANAGED,
			timeToLiveAttribute: 'ttl',
			pointInTimeRecoverySpecification: {
				pointInTimeRecoveryEnabled: true
			},
			deletionProtection: true,
			removalPolicy: cdk.RemovalPolicy.RETAIN
		});

		const siteBucket = new s3.Bucket(this, 'SiteBucket', {
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			encryption: s3.BucketEncryption.S3_MANAGED,
			enforceSSL: true,
			objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
			removalPolicy: cdk.RemovalPolicy.RETAIN
		});

		const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
			this,
			'HostedZone',
			{
				hostedZoneId: HOSTED_ZONE_ID,
				zoneName: HOSTED_ZONE_NAME
			}
		);

		const certificate = new acm.DnsValidatedCertificate(this, 'SiteCertificate', {
			domainName: SITE_DOMAIN,
			hostedZone,
			region: 'us-east-1',
			cleanupRoute53Records: false
		});

		const api = new apigatewayv2.HttpApi(this, 'Api', {
			apiName: 'safetwitch-api',
			createDefaultStage: false,
			corsPreflight: {
				allowHeaders: ['content-type'],
				allowMethods: [apigatewayv2.CorsHttpMethod.POST],
				allowOrigins: ['*'],
				maxAge: cdk.Duration.hours(1)
			}
		});

		const siteUrl = `https://${SITE_DOMAIN}`;
		const callbackUrl = `${siteUrl}/auth/twitch/callback`;
		const functionDefaults = {
			runtime: lambda.Runtime.NODEJS_24_X,
			architecture: lambda.Architecture.ARM_64,
			memorySize: 256,
			tracing: lambda.Tracing.PASS_THROUGH,
			bundling: {
				bundleAwsSDK: true,
				minify: true,
				sourceMap: true
			}
		};

		const authFunction = new lambdaNodejs.NodejsFunction(this, 'AuthFunction', {
			...functionDefaults,
			entry: path.join(__dirname, '../functions/auth.ts'),
			handler: 'handler',
			timeout: cdk.Duration.seconds(10),
			logGroup: new logs.LogGroup(this, 'AuthLogs', {
				retention: logs.RetentionDays.TWO_WEEKS,
				removalPolicy: cdk.RemovalPolicy.DESTROY
			}),
			environment: {
				TABLE_NAME: table.tableName,
				CALLBACK_URL: callbackUrl,
				TWITCH_CLIENT_ID_PARAMETER,
				TWITCH_CLIENT_SECRET_PARAMETER
			}
		});

		const statusFunction = new lambdaNodejs.NodejsFunction(this, 'StatusFunction', {
			...functionDefaults,
			entry: path.join(__dirname, '../functions/status.ts'),
			handler: 'handler',
			timeout: cdk.Duration.seconds(5),
			logGroup: new logs.LogGroup(this, 'StatusLogs', {
				retention: logs.RetentionDays.TWO_WEEKS,
				removalPolicy: cdk.RemovalPolicy.DESTROY
			}),
			environment: {
				TABLE_NAME: table.tableName
			}
		});

		table.grantReadWriteData(authFunction);
		table.grantReadData(statusFunction);

		const parameterArns = [
			TWITCH_CLIENT_ID_PARAMETER,
			TWITCH_CLIENT_SECRET_PARAMETER
		].map(parameterName => this.formatArn({
			service: 'ssm',
			resource: 'parameter',
			resourceName: parameterName.replace(/^\//, '')
		}));

		authFunction.addToRolePolicy(new iam.PolicyStatement({
			actions: ['ssm:GetParameters'],
			resources: parameterArns
		}));

		const authIntegration = new integrations.HttpLambdaIntegration(
			'AuthIntegration',
			authFunction
		);
		const statusIntegration = new integrations.HttpLambdaIntegration(
			'StatusIntegration',
			statusFunction
		);

		api.addRoutes({
			path: '/auth/twitch/start',
			methods: [apigatewayv2.HttpMethod.GET],
			integration: authIntegration
		});
		api.addRoutes({
			path: '/auth/twitch/callback',
			methods: [apigatewayv2.HttpMethod.GET],
			integration: authIntegration
		});
		api.addRoutes({
			path: '/v1/status:batch',
			methods: [apigatewayv2.HttpMethod.POST],
			integration: statusIntegration
		});

		api.addStage('DefaultStage', {
			autoDeploy: true,
			throttle: {
				burstLimit: 40,
				rateLimit: 20
			}
		});

		const apiOrigin = new origins.HttpOrigin(
			`${api.httpApiId}.execute-api.${this.region}.${this.urlSuffix}`,
			{ protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }
		);
		const apiBehavior: cloudfront.BehaviorOptions = {
			origin: apiOrigin,
			viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
			cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
			originRequestPolicy:
				cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
			responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
			compress: true
		};

		const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
			defaultRootObject: 'index.html',
			domainNames: [SITE_DOMAIN],
			certificate,
			defaultBehavior: {
				origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
				viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
				cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
				compress: true,
				responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS
			},
			additionalBehaviors: {
				'auth/*': {
					...apiBehavior,
					allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS
				},
				'v1/*': {
					...apiBehavior,
					allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL
				}
			},
			priceClass: cloudfront.PriceClass.PRICE_CLASS_100
		});

		const cloudFrontAlias = route53.RecordTarget.fromAlias(
			new route53Targets.CloudFrontTarget(distribution)
		);
		new route53.ARecord(this, 'SiteAliasIpv4', {
			zone: hostedZone,
			recordName: SITE_DOMAIN,
			target: cloudFrontAlias
		});
		new route53.AaaaRecord(this, 'SiteAliasIpv6', {
			zone: hostedZone,
			recordName: SITE_DOMAIN,
			target: cloudFrontAlias
		});

		new s3deploy.BucketDeployment(this, 'DeploySite', {
			destinationBucket: siteBucket,
			prune: true,
			sources: [s3deploy.Source.asset(path.join(__dirname, '../site'))],
			cacheControl: [
				s3deploy.CacheControl.noStore(),
				s3deploy.CacheControl.noCache(),
				s3deploy.CacheControl.mustRevalidate()
			]
		});

		new cdk.CfnOutput(this, 'SiteUrl', {
			value: siteUrl,
			description: 'SafeTwitch landing page'
		});
		new cdk.CfnOutput(this, 'ApiEndpoint', {
			value: siteUrl,
			description: 'SafeTwitch public API endpoint'
		});
		new cdk.CfnOutput(this, 'ApiGatewayOriginEndpoint', {
			value: api.apiEndpoint,
			description: 'Underlying API Gateway endpoint'
		});
		new cdk.CfnOutput(this, 'OAuthCallbackUrl', {
			value: callbackUrl,
			description: 'Register this exact OAuth callback URL with Twitch'
		});
		new cdk.CfnOutput(this, 'TwitchClientIdParameter', {
			value: TWITCH_CLIENT_ID_PARAMETER
		});
		new cdk.CfnOutput(this, 'TwitchClientSecretParameter', {
			value: TWITCH_CLIENT_SECRET_PARAMETER
		});

		cdk.Tags.of(this).add('Project', 'SafeTwitch');
	}
}
