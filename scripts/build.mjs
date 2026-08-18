import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as buildBundle } from 'esbuild';

const projectRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);
const sourceRoot = path.join(projectRoot, 'src');
const outputRoot = path.join(projectRoot, 'dist');

const baseManifest = JSON.parse(
	await readFile(path.join(sourceRoot, 'manifest.base.json'), 'utf8'),
);

const chromiumManifest = {
	...baseManifest,
	minimum_chrome_version: '144',
};

const browserManifests = {
	chromium: chromiumManifest,
	edge: chromiumManifest,
	firefox: {
		...baseManifest,
		browser_specific_settings: {
			gecko: {
				id: 'safebadge@ori.mx',
				strict_min_version: '140.0',
				data_collection_permissions: {
					required: ['websiteContent'],
				},
			},
		},
	},
};

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const compilerPath = path.join(
	projectRoot,
	'node_modules',
	'typescript',
	'bin',
	'tsc',
);
const compilation = spawnSync(
	process.execPath,
	[compilerPath, '--project', path.join(projectRoot, 'tsconfig.json')],
	{
		cwd: projectRoot,
		encoding: 'utf8',
	},
);

if (compilation.status !== 0) {
	process.stderr.write(compilation.stdout);
	process.stderr.write(compilation.stderr);
	throw new Error('TypeScript type-check failed.');
}

const bundleResult = await buildBundle({
	bundle: true,
	charset: 'utf8',
	entryPoints: [path.join(sourceRoot, 'content.ts')],
	format: 'iife',
	legalComments: 'none',
	platform: 'browser',
	target: ['chrome144', 'edge144', 'firefox140'],
	treeShaking: true,
	write: false,
});
const bundle = bundleResult.outputFiles[0];

if (!bundle) {
	throw new Error('Extension bundling produced no output.');
}

const bundledSource = bundle.text
	.replace(
		/^[\t ]*\/\/ (?:src|node_modules)\/.*(?:\r?\n|$)/gm,
		'',
	)
	.replaceAll('/* @__PURE__ */ ', '');

for (const [browser, manifest] of Object.entries(browserManifests)) {
	const browserRoot = path.join(outputRoot, browser);
	await mkdir(browserRoot, { recursive: true });
	await writeFile(path.join(browserRoot, 'content.js'), bundledSource);
	await cp(
		path.join(sourceRoot, 'content.css'),
		path.join(browserRoot, 'content.css'),
	);

	await writeFile(
		path.join(browserRoot, 'manifest.json'),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
}

console.log('Built Safe Badge to dist/.');
