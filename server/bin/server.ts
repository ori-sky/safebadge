import * as cdk from 'aws-cdk-lib/core';
import { ServerStack } from '../lib/server-stack.js';

const app = new cdk.App();

new ServerStack(app, 'SafeTwitchStack', {
	env: {
		account: process.env['CDK_DEFAULT_ACCOUNT'],
		region: process.env['CDK_DEFAULT_REGION']
	},
	description: 'SafeTwitch API'
});
