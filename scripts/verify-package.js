#!/usr/bin/env node
/**
 * Verifies that dist/ actually contains a loadable node package.
 *
 * This exists because `tsc` can report success while emitting nothing (a stale
 * build-info file is enough), which produces a tarball that installs fine and then
 * fails inside n8n. Runs as part of prepublishOnly so that can never ship.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

assert.ok(pkg.n8n, 'package.json has no "n8n" section');
assert.ok(
	pkg.keywords.includes('n8n-community-node-package'),
	'package.json is missing the n8n-community-node-package keyword',
);

const declared = [...(pkg.n8n.nodes ?? []), ...(pkg.n8n.credentials ?? [])];
assert.ok(declared.length > 0, 'no nodes or credentials declared');

let nodeCount = 0;
let credentialCount = 0;

for (const relative of declared) {
	const file = path.join(root, relative);
	assert.ok(fs.existsSync(file), `declared file is missing from the build: ${relative}`);
	assert.ok(fs.statSync(file).size > 0, `declared file is empty: ${relative}`);

	const exported = require(file);
	const Klass = Object.values(exported).find((value) => typeof value === 'function');
	assert.ok(Klass, `no class exported from ${relative}`);

	const instance = new Klass();
	const icon = instance.description ? instance.description.icon : instance.icon;

	if (instance.description) {
		nodeCount += 1;
		assert.ok(instance.description.name, `${relative} has no node name`);
		assert.strictEqual(
			typeof instance.execute === 'function' || typeof instance.poll === 'function',
			true,
			`${relative} has neither execute() nor poll()`,
		);
		assert.ok(
			Array.isArray(instance.description.properties) &&
				instance.description.properties.length > 0,
			`${relative} declares no properties`,
		);
		for (const credential of instance.description.credentials ?? []) {
			assert.ok(
				pkg.n8n.credentials.some((entry) =>
					entry.toLowerCase().includes(credential.name.toLowerCase()),
				),
				`${relative} requires credential "${credential.name}" which the package does not declare`,
			);
			if (credential.testedBy) {
				assert.strictEqual(
					typeof instance.methods?.credentialTest?.[credential.testedBy],
					'function',
					`${relative} names testedBy "${credential.testedBy}" but does not implement it`,
				);
			}
		}
	} else {
		credentialCount += 1;
		assert.ok(instance.name, `${relative} has no credential name`);
		assert.ok(instance.properties.length > 0, `${relative} declares no fields`);
	}

	if (icon && typeof icon === 'object') {
		for (const variant of ['light', 'dark']) {
			if (!icon[variant]) continue;
			const iconFile = path.resolve(path.dirname(file), icon[variant].replace('file:', ''));
			assert.ok(fs.existsSync(iconFile), `missing ${variant} icon for ${relative}: ${icon[variant]}`);
		}
	}

	console.log(`  ok  ${relative}`);
}

console.log(
	`\nverify-package: ${nodeCount} node(s), ${credentialCount} credential(s), all declared files present and loadable`,
);
